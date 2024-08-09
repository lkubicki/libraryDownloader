'use strict';

import * as cheerio from "cheerio";
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
        return this.checkIfUserIsAlreadyLoggedIn(request, "");
    }

    protected async checkIfUserIsAlreadyLoggedIn(request: any, accessToken: string): Promise<{
        isLoggedIn: boolean,
        body: string
    }> {
        const getRequestOptions = {
            resolveWithFullResponse: true,
            headers: {
                'Content-Type': 'application/json',
                'X-Auth-Token': `Bearer ${accessToken}`
            },
        };
        return new Promise((resolve, reject) => {
            request.get(this.config.bookshelfServiceUrl, getRequestOptions)
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
        await this.visitLoginForm(request, this.config.loginFormUrl);
        console.log(`${new Date().toISOString()} - Logging in as ${this.config.login}`);

        const loginRequestOptions = {
            resolveWithFullResponse: true,
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
            console.log(`${new Date().toISOString()} - Getting page number: ${pageNbr}`);
            isLastPage = await this.downloadPublicationsFromPage(request, accessToken, refreshToken, pageNbr++);
            let response = await this.refreshTokens(request, accessToken, refreshToken);
            accessToken = response['authorizationToken'];
            refreshToken = response['refreshToken'];
        } while (!isLastPage);
    }

    private async downloadPublicationsFromPage(request: any, accessToken: string, refreshToken: string, pageNbr: number): Promise<boolean> {
        const securityHeadersOptions = {
            resolveWithFullResponse: true,
            headers: {
                'Content-Type': 'application/json',
                'X-Auth-Token': `Bearer ${accessToken}`
            }
        }
        let pageUrl = this.config.bookshelfServiceUrl.replace("_PAGE_", pageNbr);
        let pageBodyString = await this.getPageBodyWithAdditionalOptions(request, pageUrl, timingUtils.ONE_SECOND * 3, false, securityHeadersOptions);
        let pageBody = JSON.parse(pageBodyString);

        for (let item of pageBody.items) {
            switch (item.type) {
                case 'SINGLE':
                    await this.downloadSingleProduct(request, item.downloadInfoId, item.itemDigest, accessToken);
                    break;
                case 'GROUP':
                    break;
                default:
                    break;
            }
        }

        return new Promise((resolve, reject) => {
            if (this.config.itemsPerPage * pageNbr > pageBody.totalResults) {
                resolve(true);
            } else {
                resolve(false);
            }
        })
    }

    private async downloadSingleProduct(request: any, downloadId: string, itemDigest: string, accessToken: string) {
        let downloadData = await this.fetchDownloadData(request, downloadId, itemDigest, accessToken);
        let authors = downloadData.product.authors
            .map(author => author.label)
            .join(', ');
        // let packages = Object.fromEntries(downloadData.packages.map(pkg => [pkg.label, pkg.id]));
        let publicationData = {
            downloadId: downloadId,
            digest: itemDigest,
            title: downloadData.product.title,
            authors: authors,
            packages: downloadData.packages
        }

        await this.prepareAndDownloadPublication(request, publicationData, accessToken);

        return new Promise((resolve, reject) => {
                resolve(true);
            }
        );
    }


    private async getAllPublicationsDataFromPage(request: any, accessToken: string, refreshToken: string, pageNbr: number): Promise<boolean> {
        return new Promise((resolve, reject) => {
                resolve(true);
            }
        );
    }


    private async prepareAndDownloadPublication(request: any, publicationData: Object, accessToken: string) {
        let isReady = await this.prepareProductToDownload(request, publicationData['title'], publicationData['downloadId'], publicationData['digest'], accessToken);
        console.log(`${new Date().toISOString()} - Package for ${publicationData['title']} ${isReady ? 'prepared' : 'could not be prepared'}`);

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

    private async downloadAllPublicationIssues(request: any, productPageBody: string) {
        const shelfPagesLinks: string[] = this.getPagesLinks(productPageBody, this.config.mainPageUrl);
        let pageBody = productPageBody;
        // await this.downloadPublicationsFromPage(request, pageBody);
        for (let pageUrl of shelfPagesLinks) {
            console.log(`${new Date().toISOString()} - Changing issues page to: ${pageUrl}`);
            pageBody = await this.getPageBody(request, pageUrl, timingUtils.ONE_SECOND);
            // await this.downloadPublicationsFromPage(request, pageBody);
        }
    }

    private getPagesLinks(body: string, mainPageUrl: string) {
        let result: string[] = [];
        const $ = cheerio.load(body);
        $('.pages a').each(function (i, elem) {
            if (elem.attribs['href'].indexOf('pageNumber') !== -1 &&
                result.indexOf(mainPageUrl + elem.attribs['href']) < 0) {
                const linkUrl = mainPageUrl + elem.attribs['href'];
                result.push(linkUrl);
            }
        });
        return result;
    }

    private async prepareProductToDownload(request: any, title: string, downloadId: string, digest: string, accessToken: string) {
        let numberOfAttempts = 1
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
            console.log(`${new Date().toISOString()} - Check #${numberOfAttempts}, package preparation progress - ${response['progress']}`);
        };

        return new Promise((resolve, reject) => {
            resolve(numberOfAttempts < this.config.maxPreparationAttempt);
        });
    }

    private async downloadPublicationPackage(request: any, title: string, authors: string, downloadId: string, digest: string, pkg: {
        label: string,
        id: string
    }, accessToken: string) {
        let publicationName: string = stringUtils.formatPathName(`${title}`) + ' - ' + stringUtils.formatPathName(`${authors}`);
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

        return this.fixUrlCharacters(this.config.mainPageUrl + downloadUrlsData['directDownloadUrl']);
    }

    private async refreshTokens(request: any, accessToken, refreshToken) {
        let responseString = await this.postForPageBodyWithAdditionalOptions(request, this.config.refreshTokensService, timingUtils.ONE_SECOND, false, this.prepareRefreshTokenOptions(accessToken, refreshToken))
        return JSON.parse(responseString);
    }

    private prepareProductUrl(downloadId: string, itemDigest: string) {
        let parameters = new Map([['_DOWNLOADID_', downloadId],
            ['_DIGEST_', itemDigest]]);

        return this.prepareUrl(this.config.filePackagesUrl, parameters);
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

    private prepareAuthTokenHeader(accessToken: string) {
        return {
            resolveWithFullResponse: true,
            headers: {
                'Content-Type': 'application/json',
                'X-Auth-Token': `Bearer ${accessToken}`
            },
        };
    }

    private prepareRefreshTokenOptions(accessToken: string, refreshToken: string) {
        return {
            resolveWithFullResponse: true,
            headers: {
                'Content-Type': 'application/json',
                'X-Auth-Token': `Bearer ${accessToken}`
            },
            body: {
                refreshToken: refreshToken
            }
        };
    }
}