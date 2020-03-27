'use strict';

import * as cheerio from "cheerio";
import * as FS from "fs";
import {Bookstore} from "./bookstore";
import {filesystemUtils} from "../utils/filesystemUtils";
import {timingUtils} from "../utils/timingUtils";
import {stringUtils} from "../utils/stringUtils";

export class Virtualo extends Bookstore {
    protected notLoggedInRedirectUrlPart: string = "login";

    protected async logIn(request: any): Promise<string> {
        await timingUtils.delay(timingUtils.ONE_SECOND * 3);
        console.log(`${new Date().toISOString()} - Logging in as ${this.config.login}`);

        const loginPostRequestOptions = {
            resolveWithFullResponse: true,
            method: 'POST',
            headers: {
                origin: 'https://virtualo.pl',
                referer: this.config.loginFormUrl
            },
            form: {
                email: this.config.login,
                password: this.config.password
            }
        };
        const checkLoginGetRequestOptions = {
            resolveWithFullResponse: true
        };

        return new Promise((resolve, reject) => {
            let response = request.post(this.config.loginServiceUrl, loginPostRequestOptions)
                .then(() => {
                    request.get(this.config.bookshelfUrl, checkLoginGetRequestOptions)
                        .then((response) => {
                            if (response.request.uri.href.indexOf(this.notLoggedInRedirectUrlPart) < 0) {
                                console.log(`${new Date().toISOString()} - Logged in as ${this.config.login}`);
                                resolve(response.body);
                            } else {
                                reject(`Could not log in as ${this.config.login}`);
                            }
                        })
                        .catch((error) => {
                            reject(`Could not log in as ${this.config.login}. Error: ${error}`);
                        })
                })
                .catch((error) => {
                    reject(`Could not log in as ${this.config.login}. Error: ${error}`);
                });
        });
    }

    protected async getProducts(request: any, bookshelfPageBody: string) {
        let $ = cheerio.load(bookshelfPageBody);
        const pageUrls: string[] = this.getPageUrls($, this.config.mainPageUrl, $('ul.pagination li a'));
        var pageBody = bookshelfPageBody;
        do {
            await this.getProductsFromPage(request, pageBody);
            let nextPageUrl = pageUrls.shift();
            if (nextPageUrl != undefined) {
                console.log(`${new Date().toISOString()} - Getting to the next page: ${nextPageUrl}`);
                pageBody = await this.getPageBody(request, nextPageUrl, timingUtils.ONE_SECOND);
            } else {
                pageBody = undefined;
            }
        } while (pageBody != undefined)
    }

    private getPageUrls($: any, mainPageUrl: string, pagingLinkElements: any): string[] {
        let pageUrls: string[] = [];
        for (let pageLink of $(pagingLinkElements)) {
            const pageUrl = `${mainPageUrl}${pageLink.attribs['href']}`;
            if (pageUrls.indexOf(pageUrl) < 0) pageUrls.push(pageUrl);
        }
        return pageUrls;
    }

    private async getProductsFromPage(request: any, bookshelfPageBody: string) {
        // console.log(bookshelfPageBody);
        let $ = cheerio.load(bookshelfPageBody);
        for (let productElement of $('li.product')) {
            const title = $('div.content.columns div.title a', productElement).text().trim();
            const authors = this.getAuthors($, $('div.content.columns div.authors a', productElement));
            const downloadLinks = this.getDownloadLinks($, $('.library-downloads.downloads .buttons a', productElement), this.config.mainPageUrl);
            await this.downloadProduct(request, downloadLinks, title, authors);
        }
    }

    private getAuthors($: any, authorsElements: any): string {
        let authors: string = "";
        for (let authorElement of authorsElements) {
            let author = $(authorElement).text().trim();
            authors += `${author}, `;
        }
        return authors.replace(/, $/g, '');
    }

    private getDownloadLinks($: any, downloadElements: any, mainPageUrl: string): { fileType: string, downloadLink: string }[] {
        let downloads: { fileType: string, downloadLink: string }[] = [];
        for (let downloadElement of downloadElements) {
            let fileType = $(downloadElement).text().trim();
            let downloadLink = `${mainPageUrl}/${$(downloadElement)[0].attribs['href']}`;
            downloads.push({fileType: fileType, downloadLink: downloadLink});
        }
        return downloads;
    }

    private async downloadProduct(request: any, downloadLinks: { fileType: string; downloadLink: string }[], title: string, authors: string) {
        let productTitle: string = stringUtils.formatPathName(`${title}`);
        if (authors != '') {
            productTitle += ` - ${authors}`;
        }
        const downloadDir = `${this.booksDir}/${productTitle}`;
        if (!(await filesystemUtils.checkIfDirectoryExists(downloadDir))) {
            FS.mkdirSync(downloadDir);
        }
        for (let downloadLink of downloadLinks) {
            let fileName = `${productTitle}.${downloadLink.fileType}`;
            if (!(await filesystemUtils.checkIfElementExists(downloadDir, fileName))) {
                console.log(`${new Date().toISOString()} - Downloading ${downloadLink.fileType} file for ${productTitle}`);
                await this.downloadFile(request, downloadLink.downloadLink, timingUtils.ONE_SECOND * 2, downloadDir, fileName);
            } else {
                console.log(`${new Date().toISOString()} - No need to download ${downloadLink.fileType} file for ${productTitle} - file already exists`);
            }
        }
    }
}
