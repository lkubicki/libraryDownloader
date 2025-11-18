'use strict';

import * as FS from "fs";
import {Bookstore} from "./bookstore";
import {filesystemUtils} from "../utils/filesystemUtils";
import {stringUtils} from "../utils/stringUtils";
import {timingUtils} from "../utils/timingUtils";

const FILE_EXTENSIONS = {
    mp3: "zip",
    MP3: "zip",
    epub: "epub",
    EPUB: "epub",
    mobi: "mobi",
    MOBI: "mobi",
    pdf: "pdf",
    PDF: "pdf",
};

export class Publio extends Bookstore {
    protected async checkIfUserIsLoggedIn(request: any): Promise<{ isLoggedIn: boolean, body: string }> {
        return this.checkIfUserIsAlreadyLoggedIn(request);
    }

    protected async checkIfUserIsAlreadyLoggedIn(request: any): Promise<{
        isLoggedIn: boolean,
        body: string
    }> {
        const getRequestOptions = this.prepareBookshelfHeader();
        return new Promise((resolve, reject) => {
            request.get(this.config.bookshelfServiceUrl.replace("_PAGE_", "1"), getRequestOptions)
                .then((response) => {
                    resolve({
                        isLoggedIn: true,
                        body: response.body
                    });
                })
                .catch((error) => {
                    if (error.response.statusCode === 401) {
                        resolve({
                            isLoggedIn: false,
                            body: ""
                        });
                    }
                    reject(`Could not check if ${this.config.login} is logged in. Error: ${error}`)
                });
        });
    }

    protected async logIn(request: any): Promise<string> {
        // await this.visitLoginForm(request, this.config.loginFormUrl);
        console.log(`${new Date().toISOString()} - Logging in as ${this.config.login}`);

        const loginRequestOptions = {
            resolveWithFullResponse: true,
            headers: {
                'User-Agent': undefined,
                'Content-Type': 'application/json',
                'app-version': this.config.appVersion,
                'app-platform': this.config.appPlatform,
                'app-name': this.config.appName,
            },
            json: {
                login: this.config.login,
                password: this.config.password,
            }
        };

        return this.sendLoginForm(request, loginRequestOptions);
    }

    protected sendLoginForm(request: any, postRequestOptions: object): Promise<string> {
        return new Promise((resolve, reject) => {
            request.post(this.config.loginServiceUrl, postRequestOptions)
                .then((response) => {
                    if (response.statusCode === 200) {
                        console.log(`${new Date().toISOString()} - Logged in user ${this.config.login} in ${this.config.bookstoreName} bookstore`);
                        resolve(JSON.parse(response.body));
                    } else {
                        reject(`Got response code ${response.statusCode} while logging in`);
                    }
                })
                .catch((error) => {
                    reject(`Could not log in as ${this.config.login}. Error: ${error}`);
                })
        });
    }

    async getProducts(request: any, loginResponse: Object) {
        let accessToken = loginResponse['authorizationToken'];
        let refreshToken = loginResponse['refreshToken'];
        let pageNbr = 1;
        let isLastPage = false;
        do {
            console.log(`${new Date().toISOString()} - Getting library page number: ${pageNbr}`);
            isLastPage = await this.downloadPublicationsFromPage(request, pageNbr++, accessToken, refreshToken);
            let response = await this.refreshTokens(request, accessToken, refreshToken);
            accessToken = response['authorizationToken'];
            refreshToken = response['refreshToken'];
        } while (!isLastPage);
    }

    private async downloadPublicationsFromPage(request: any, pageNbr: number, accessToken: string, refreshToken: string): Promise<boolean> {
        let pageUrl = this.config.bookshelfServiceUrl.replace("_PAGE_", pageNbr);
        let pageBodyString = await this.getPageBodyWithAdditionalOptions(request, pageUrl, timingUtils.ONE_SECOND * 3, false, this.prepareAuthTokenHeader(accessToken));
        let pageBody = JSON.parse(pageBodyString);

        for (let item of pageBody.items) {
            switch (item.type) {
                case 'SINGLE':
                    await this.downloadSingleProduct(request, item.downloadInfoId, item.itemDigest, accessToken);
                    break;
                case 'GROUP':
                    await this.downloadAllPublicationIssues(request, item.publication.title, item.publication.type, item.publicationId, accessToken, refreshToken);
                    break;
                default:
                    break;
            }
        }

        return new Promise((resolve) => {
            if (this.config.itemsPerPage * pageNbr > pageBody.totalResults) {
                resolve(true);
            } else {
                resolve(false);
            }
        })
    }

    private async downloadPublicationIssuesFromPage(request: any, publicationType: string, publicationId: string, accessToken: string, refreshToken: string): Promise<boolean> {
        let pageNumber = 1;
        let numberOfPages = 1;

        do {
            let pageUrl = this.preparePublicationIssuesUrl(publicationType, publicationId, pageNumber);
            let pageBodyString = await this.getPageBodyWithAdditionalOptions(request, pageUrl, timingUtils.ONE_SECOND * 3, false, this.prepareAuthTokenHeader(accessToken));
            let pageBody = JSON.parse(pageBodyString);
            numberOfPages = Math.ceil(pageBody.totalResults / this.config.itemsPerPage);

            for (let item of pageBody.items) {
                switch (item.type) {
                    case 'SINGLE':
                        await this.downloadSingleProduct(request, item.downloadInfoId, item.itemDigest, accessToken);
                        break;
                    case 'GROUP':
                        await this.downloadAllPublicationIssues(request, item.publication.type, item.publication.type, item.publicationId, accessToken, refreshToken);
                        break;
                    default:
                        break;
                }
            }
            pageNumber++;
        } while (pageNumber < numberOfPages);

        return new Promise((resolve) => {
            resolve(true);
        })
    }

    private async downloadSingleProduct(request: any, downloadId: string, itemDigest: string, accessToken: string) {
        let downloadData = await this.fetchDownloadData(request, downloadId, itemDigest, accessToken);
        let authors = downloadData.product.authors
            .map(author => author.label)
            .join(', ');
        let publicationData = {
            downloadId: downloadId,
            digest: itemDigest,
            title: downloadData.product.title,
            authors: authors,
            packages: downloadData.packages
        }

        await this.prepareAndDownloadPublication(request, publicationData, accessToken);

        return new Promise((resolve) => {
                resolve(true);
            }
        );
    }


    private async prepareAndDownloadPublication(request: any, publicationData: Object, accessToken: string) {
        let isReady = await this.prepareProductToDownload(request, publicationData['title'], publicationData['downloadId'], publicationData['digest'], accessToken);
        console.log(`${new Date().toISOString()} - Package for ${publicationData['title']} ${isReady ? 'is ready' : 'could not be prepared'}`);

        if (isReady) {
            for (let pkg of publicationData['packages']) {
                await this.downloadPublicationPackage(request, publicationData['title'], publicationData['authors'], publicationData['downloadId'], publicationData['digest'], pkg, accessToken);
            }
        }
    }

    private async startPackagePreparation(request: any, accessToken: string, downloadId: string, digest: string) {
        let preparePublicationUrl = this.preparePrepareDownloadUrl(downloadId, digest);
        let preparePostOptions = this.prepareAuthTokenHeader(accessToken);
        await this.postForPageBodyWithAdditionalOptions(request, preparePublicationUrl, timingUtils.ONE_SECOND, false, preparePostOptions);
    }

    private async downloadAllPublicationIssues(request: any, publicationName: string, publicationType: string, publicationId: string, accessToken: string, refreshToken: string) {
        let pageNbr = 1;
        let isLastPage = false;
        do {
            console.log(`${new Date().toISOString()} - Getting page number: ${pageNbr++} for ${publicationName}`);
            isLastPage = await this.downloadPublicationIssuesFromPage(request, publicationType, publicationId, accessToken, refreshToken);
            let response = await this.refreshTokens(request, accessToken, refreshToken);
            accessToken = response['authorizationToken'];
            refreshToken = response['refreshToken'];
        } while (!isLastPage);
    }

    private async prepareProductToDownload(request: any, title: string, downloadId: string, digest: string, accessToken: string) {
        let numberOfAttempts = 0
        let statusUrl = this.prepareDownloadStatusUrl(downloadId, digest);
        let additionalRequestParameters = this.prepareAuthTokenHeader(accessToken);

        let progressData = await this.getPageBodyWithAdditionalOptions(request, statusUrl, timingUtils.ONE_SECOND, false, additionalRequestParameters);
        let response = JSON.parse(progressData);

        if (response['status'] != 'READY') {
            console.log(`${new Date().toISOString()} - Starting ${title} package preparation`);
            await this.startPackagePreparation(request, accessToken, downloadId, digest);
        }

        while (response['status'] != 'READY' && numberOfAttempts++ < this.config.maxPreparationAttempt) {
            let progressData = await this.getPageBodyWithAdditionalOptions(request, statusUrl, timingUtils.ONE_SECOND, false, additionalRequestParameters);
            response = JSON.parse(progressData);
            console.log(`${new Date().toISOString()} - Check #${numberOfAttempts}, package preparation progress - ${(response['status'] !== 'READY') ? response['progress'] : response['status']}`);
        }

        return new Promise((resolve) => {
            resolve(numberOfAttempts < this.config.maxPreparationAttempt);
        });
    }

    private async downloadPublicationPackage(request: any, title: string, authors: string, downloadId: string, digest: string, pkg: {
        label: string,
        id: string
    }, accessToken: string) {
        let publicationName: string = (stringUtils.formatPathName(`${title}`) + ' - ' + stringUtils.formatPathName(`${authors}`)).replace(/\s+-\s+$/g, '');
        const downloadDir = `${this.booksDir}/${publicationName}`;
        if (!(await filesystemUtils.checkIfDirectoryExists(downloadDir))) {
            FS.mkdirSync(downloadDir);
        }

        let fileName = this.prepareFileName(publicationName, pkg.label);
        if (!(await filesystemUtils.checkIfElementExists(downloadDir, fileName))) {
            console.log(`${new Date().toISOString()} - Fetching download link for ${pkg.label} file for ${publicationName}`);
            let downloadLink = await this.fetchDownloadLink(request, downloadId, digest, pkg.id, accessToken);
            console.log(`${new Date().toISOString()} - Downloading ${pkg.label} file for ${publicationName}`);
            await this.downloadFile(request, downloadLink, timingUtils.ONE_SECOND * 2, downloadDir, fileName)
        } else {
            console.log(`${new Date().toISOString()} - No need to download ${pkg.label} file for ${publicationName} - file already exists`);
        }
    }

    private prepareFileName(packageTitle: string, fileType: string) {
        let fileExtension = FILE_EXTENSIONS[fileType.toLowerCase()];
        if (fileExtension == undefined) {
            fileExtension = fileType;
        }
        return `${packageTitle}.${fileExtension}`;
    }

    private async fetchDownloadData(request: any, downloadId: string, itemDigest: string, accessToken: string) {
        let downloadDataUrl = this.prepareProductUrl(downloadId, itemDigest);
        let postRequestOptions = this.prepareAuthTokenHeader(accessToken);
        let pageBody = await this.getPageBodyWithAdditionalOptions(request, downloadDataUrl, 2 * timingUtils.ONE_SECOND, false, postRequestOptions);
        return JSON.parse(pageBody);
    }

    private async fetchDownloadLink(request: any, downloadId: string, digest: string, packageId: string, accessToken: string) {
        let downloadInitUrl = this.prepareInitDownloadUrl(downloadId, digest, packageId);
        let additionalOptions = this.prepareAuthTokenHeader(accessToken);

        let downloadUrlsDataString = await this.postForPageBodyWithAdditionalOptions(request, downloadInitUrl, timingUtils.ONE_SECOND, false, additionalOptions)
        let downloadUrlsData = JSON.parse(downloadUrlsDataString);

        return this.fixUrlCharacters(`${this.config.mainPageUrl}${downloadUrlsData['directDownloadUrl']}`);
    }

    private async refreshTokens(request: any, accessToken: string, refreshToken: string) {
        let responseString = await this.postForPageBodyWithAdditionalOptions(request, this.config.refreshTokensService, timingUtils.ONE_SECOND, false, this.prepareRefreshTokenOptions(accessToken, refreshToken))
        return JSON.parse(responseString);
    }

    private prepareProductUrl(downloadId: string, itemDigest: string) {
        let parameters = new Map([['_DOWNLOADID_', downloadId],
            ['_DIGEST_', itemDigest]]);

        return this.prepareUrl(this.config.filePackagesUrl, parameters);
    }

    private preparePublicationIssuesUrl(publicationType: string, publicationId: string, pageNumber: number) {
        let parameters = new Map([['_PUBLICATIONTYPE_', publicationType.replace('_', '-').toLowerCase()],
            ['_PUBLICATIONID_', publicationId],
            ['_PERPAGE_', this.config.itemsPerPage],
            ['_PAGE_', pageNumber],
        ]);

        return this.prepareUrl(this.config.publicationIssuesListUrl, parameters);
    }

    private prepareInitDownloadUrl(downloadId: string, itemDigest: string, pkgNumber: string) {
        let parameters = new Map([['_DOWNLOADID_', downloadId],
            ['_DIGEST_', itemDigest],
            ['_PACKAGE_', pkgNumber]]);

        return this.prepareUrl(this.config.initDownloadLinksUrl, parameters);
    }

    private preparePrepareDownloadUrl(downloadId: string, itemDigest: string) {
        let parameters = new Map([['_DOWNLOADID_', downloadId],
            ['_DIGEST_', itemDigest]]);

        return this.prepareUrl(this.config.preparePublicationUrl, parameters);
    }

    private prepareDownloadStatusUrl(downloadId: string, itemDigest: string) {
        let parameters = new Map([['_DOWNLOADID_', downloadId],
            ['_DIGEST_', itemDigest]]);

        return this.prepareUrl(this.config.preparationStatusUrl, parameters);
    }

    private prepareBookshelfHeader() {
        return {
            resolveWithFullResponse: true,
            followRedirect: true,
            headers: {
                'User-Agent': undefined,
                'Content-Type': 'application/json',
                'app-version': this.config.appVersion,
                'app-platform': this.config.appPlatform,
                'app-name': this.config.appName,
            }
        }
    }

    private prepareAuthTokenHeader(accessToken: string) {
        return {
            resolveWithFullResponse: true,
            followRedirect: true,
            headers: {
                'User-Agent': undefined,
                'Content-Type': 'application/json',
                'X-Auth-Token': `Bearer ${accessToken}`,
            },
        };
    }

    private prepareRefreshTokenOptions(accessToken: string, refreshToken: string) {
        return {
            resolveWithFullResponse: true,
            headers: {
                'User-Agent': undefined,
                'Content-Type': 'application/json',
                'X-Auth-Token': `Bearer ${accessToken}`
            },
            json: {
                refreshToken: refreshToken
            }
        };
    }
}