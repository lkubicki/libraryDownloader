'use strict';

import * as cheerio from "cheerio";
import * as FS from "fs";
import {Bookstore} from "./bookstore";
import {timingUtils} from "../utils/timingUtils";
import {filesystemUtils} from "../utils/filesystemUtils";
import {stringUtils} from "../utils/stringUtils";

const ONE_SECOND: number = 1000;

export class Publio extends Bookstore {
    protected notLoggedInRedirectUrlPart: string = "logowanie";

    protected async logIn(request: any): Promise<string> {
        const loginFormBody = await this.visitLoginForm(request, this.config.loginFormUrl);
        const csrfToken: Object = this.getCsrfTokenValue(loginFormBody);
        console.log(`${new Date().toISOString()} - Logging in as ${this.config.login}`);
        return new Promise((resolve, reject) => {
            const getRequestOptions = {
                resolveWithFullResponse: true,
                method: "POST",
                form: {
                    _csrf: csrfToken['csrfToken'],
                    action: "LOGIN",
                    j_username: this.config.login,
                    j_password: this.config.password,
                }
            };
            request.post(this.config.loginServiceUrl, getRequestOptions)
                .then((response) => {
                    if (response.request.uri.href.indexOf(this.notLoggedInRedirectUrlPart) < 0) {
                        console.log(`${new Date().toISOString()} - Logged in as ${this.config.login}`);
                        resolve(response.body);
                    } else {
                        reject(`Could not log in as ${this.config.login}`);
                    }
                })
        });
    }

    async getProducts(request: any, bookshelfPageBody: string) {
        const shelfPagesLinks: string[] = this.getPagesLinks(bookshelfPageBody, this.config.mainPageUrl);
        console.log(`${new Date().toISOString()} - Found ${shelfPagesLinks.length + 1} ` + (shelfPagesLinks.length >= 1 ? `bookshelves` : `bookshelf`));
        let pageBody = bookshelfPageBody;
        await this.downloadPublicationsFromPage(request, pageBody);
        for (let shelfPageUrl of shelfPagesLinks) {
            console.log(`${new Date().toISOString()} - Changing page to: ${shelfPageUrl}`);
            pageBody = await this.getPageBody(request, shelfPageUrl, ONE_SECOND);
            await this.downloadPublicationsFromPage(request, pageBody);
        }
    }

    private getCsrfTokenValue(body: string): { csrfToken: string, csrfTokenName: string, csrfHeaderName: string } {
        const $ = cheerio.load(body);
        const csrfToken = $("meta[name='csrfToken']").attr("content");
        const csrfTokenName = $("meta[name='csrfParameterName']").attr("content");
        const csrfHeaderName = $("meta[name='csrfHeaderName']").attr("content");
        return {csrfToken, csrfTokenName, csrfHeaderName};
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

    private async downloadPublicationsFromPage(request: any, pageBody: string) {
        const $ = cheerio.load(pageBody);
        for (let element of $('.purchasedPub a.title')) {
            console.log(`${new Date().toISOString()} - Downloading '${element.attribs['title']}'`);
            await this.downloadPublication(request, element.attribs['href'].trim());
        }
    }

    private async downloadPublication(request: any, elem: string) {
        const linkUrl = this.config.mainPageUrl + elem;
        let productPageBody: string = await this.getPageBody(request, linkUrl, ONE_SECOND);
        if (elem.indexOf('pressTitle') >= 0) {
            console.log(`${new Date().toISOString()} - Got press title - getting issues pages`)
            await this.downloadAllPublicationIssues(request, productPageBody);
        } else {
            await this.prepareAndDownloadPublication(request, productPageBody);
        }
        return new Promise((resolve) => {
            resolve(productPageBody);
        })

    }

    private async prepareAndDownloadPublication(request: any, productPageBody: string) {
        const productMetadata = this.getProductMetadata(productPageBody);
        console.log(`${new Date().toISOString()} - Found ${productMetadata.productType}: ${productMetadata.productTitle}` +
            (productMetadata.authors != '' ? ` by ${productMetadata.authors}` : ``));
        const productLinks: { prepareLink: string, packageId: string, downloadLinks: { fileType: string, downloadLink: string }[] } =
            await this.getProductDownloadLinks(request, productPageBody);

        console.log(`${new Date().toISOString()} - Preparing ${productMetadata.productTitle} package to download`);
        await this.prepareProductToDownload(request, productLinks.packageId, productLinks.prepareLink);
        console.log(`${new Date().toISOString()} - Package for ${productMetadata.productTitle} prepared`);

        await this.downloadPublicationPackages(request, productLinks.downloadLinks, productMetadata);
    }

    private async downloadAllPublicationIssues(request: any, productPageBody: string) {
        const shelfPagesLinks: string[] = this.getPagesLinks(productPageBody, this.config.mainPageUrl);
        let pageBody = productPageBody;
        await this.downloadPublicationsFromPage(request, pageBody);
        for (let pageUrl of shelfPagesLinks) {
            console.log(`${new Date().toISOString()} - Changing issues page to: ${pageUrl}`);
            pageBody = await this.getPageBody(request, pageUrl, ONE_SECOND);
            await this.downloadPublicationsFromPage(request, pageBody);
        }
    }

    private async getProductDownloadLinks(request: any, body: string): Promise<{ prepareLink: string, packageId: string, downloadLinks: { fileType: string, downloadLink: string }[] }> {
        const packageId: string = this.getPackageId(body);
        return new Promise((resolve, reject) => {
            if (packageId) {
                const productDownloadPartUrl = `${this.config.productDownloadTypesServiceUrl}?id=${packageId}`;
                this.getPageBody(request, productDownloadPartUrl, ONE_SECOND).then((body) => {
                    resolve(this.getDownloadLinksFromPage(body, packageId));
                })
            } else {
                reject('Could not find packageId within:\n' + body);
            }
        });
    }

    private getPackageId(body: string): string {
        const $ = cheerio.load(body);
        const DOWNLOAD_INFO_TEXT = 'returnDownloadInfoId:';
        const DOWNLOAD_INFO_PATTERN = DOWNLOAD_INFO_TEXT + '.*?[0-9]+';

        for (let script of $('script')) {
            if (script.children[0] != undefined && script.children[0].data != undefined) {
                let regexp = new RegExp(DOWNLOAD_INFO_PATTERN);
                let matched = script.children[0].data.search(regexp);
                if (matched >= 0) {
                    const endOfLineIndex = script.children[0].data.indexOf('\n', matched);
                    const returnDownloadInfoId = script.children[0].data.substring(matched, endOfLineIndex);
                    return returnDownloadInfoId.replace(DOWNLOAD_INFO_TEXT, '').trim();
                }
            }
        }
    }

    private getAvailableTypes(packageItemRadiobuttons: any): number[] {
        let availableTypes: number[] = [];
        for (let packageItemRadioButton of packageItemRadiobuttons) {
            availableTypes.push(packageItemRadioButton.attribs['value'])
        }
        return availableTypes;
    }

    private getAvailableFileTypes($: any, packageTypeItems: any): { fileType: string; packageType: number }[] {
        let availableTypes: { fileType: string, packageType: number }[] = [];
        for (let packageTypeItem of packageTypeItems) {
            let fileType: number, fileTypeName: string;
            for (let child of $(packageTypeItem).children('input:radio, a.format')) {
                if (child.name === 'input') {
                    fileType = $(child)[0].attribs['value']
                } else if (child.name === 'a') {
                    fileTypeName = $(child).text().trim();
                }
            }
            availableTypes.push({fileType: fileTypeName, packageType: fileType})
        }
        return availableTypes;
    }

    private getDownloadLinksFromPage(downloadTypesPartBody: string, packageId: string): { prepareLink: string, packageId: string, downloadLinks: { fileType: string, downloadLink: string }[] } {
        const $ = cheerio.load(downloadTypesPartBody);
        let downloadLinks: { fileType: string, downloadLink: string }[] = [];
        for (let availableType of this.getAvailableFileTypes($, $('.packageItem'))) {
            downloadLinks.push({
                fileType: availableType.fileType,
                downloadLink: `https://www.publio.pl/klient/pobieranie/pobierz-zestaw.html?downloadInfoId=${packageId}&downloadPackageId=${availableType.packageType}`
            });
        }
        return {
            prepareLink: `https://www.publio.pl/klient/pobieranie/ajax/prepare.html?statusId=${packageId}&startId=${packageId}`,
            packageId: packageId,
            downloadLinks: downloadLinks
        };
    }

    private async prepareProductToDownload(request: any, packageId: string, prepareLink: string) {
        let response: Object;
        do {
            let progressData = await this.getPageBody(request, prepareLink, ONE_SECOND);
            response = JSON.parse(progressData);
        } while (response[packageId] != 'READY');
        return new Promise((resolve, reject) => {
            resolve();
        });
    }

    private getProductMetadata(productPageBody: string): { productType: string, productTitle: string, authors: string } {
        let $ = cheerio.load(productPageBody);

        let title: string = $('.productDownloadInfo a.title').text().replace(/\s+/g, ' ').trim();

        let authors: string = "";
        let authorLinks = $('.productDownloadInfo .author a');
        if (authorLinks != undefined) {
            for (let authorLink of authorLinks) {
                let author = authorLink.attribs['title'].trim();
                authors += `${author}, `;
            }
            authors = authors.replace(/, $/g, '');
        }

        return {
            productType: $('.productDownloadInfo .desc .type').text(),
            productTitle: title,
            authors: authors
        }
    }

    private async downloadPublicationPackages(request: any, downloadLinks: { fileType: string; downloadLink: string }[], productMetadata: { productType: string; productTitle: string; authors: string }) {
        let packageTitle: string = stringUtils.formatPathName(`${productMetadata.productTitle}`);
        if (productMetadata.authors != '') {
            packageTitle += ` - ${productMetadata.authors}`;
        }
        const downloadDir = `${this.booksDir}/${packageTitle}`;
        if (!(await filesystemUtils.checkIfDirectoryExists(downloadDir))) {
            FS.mkdirSync(downloadDir);
        }
        for (let downloadLink of downloadLinks) {
            let fileName = `${packageTitle}.${downloadLink.fileType}`;
            if (!(await filesystemUtils.checkIfElementExists(downloadDir, fileName))) {
                console.log(`${new Date().toISOString()} - Downloading ${downloadLink.fileType} file for ${productMetadata.productTitle}`);
                await this.checkSizeAndDownloadFile(request, downloadLink.downloadLink, ONE_SECOND * 2, downloadDir, fileName)
                // await this.downloadPublicationPackage(request, downloadDir, fileName, downloadLink.downloadLink);
            } else {
                console.log(`${new Date().toISOString()} - No need to download ${downloadLink.fileType} file for ${productMetadata.productTitle} - file already exists`);
            }
        }
    }
}