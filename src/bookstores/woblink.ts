'use strict';

import * as cheerio from "cheerio";
import * as FS from "fs";
import {Bookstore} from "./bookstore";
import {filesystemUtils} from "../utils/filesystemUtils";
import {timingUtils} from "../utils/timingUtils";
import {stringUtils} from "../utils/stringUtils";

const ONE_SECOND: number = 1000;

export class Woblink extends Bookstore {
    protected notLoggedInRedirectUrlPart: string = "logowanie";

    protected async logIn(request: any): Promise<string> {
        await this.visitLoginForm(request, this.config.loginFormUrl);
        console.log(`${new Date().toISOString()} - Logging in as ${this.config.login}`);
        return new Promise((resolve, reject) => {
            const postRequestOptions = {
                resolveWithFullResponse: true,
                method: "POST",
                form: {
                    login: {
                        email: this.config.login,
                        password: this.config.password
                    },
                    referer: this.config.bookshelfUrl
                }
            };
            request.post(this.config.loginServiceUrl, postRequestOptions)
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

    protected async getProducts(request: any, bookshelfPageBody: string) {
        let pageUrls: string[] = this.getPageUrls(bookshelfPageBody, this.config.mainPageUrl);
        console.log(`${new Date().toISOString()} - Found ${pageUrls.length + 1} bookshelf ` + (pageUrls.length >= 1 ? `pages` : `page`));
        let pageBody = bookshelfPageBody;
        await this.downloadPublicationsFromPage(request, pageBody);
        for (let shelfPageUrl of pageUrls) {
            console.log(`${new Date().toISOString()} - Changing page to: ${shelfPageUrl}`);
            pageBody = await this.getPageBody(request, shelfPageUrl, ONE_SECOND);
            await this.downloadPublicationsFromPage(request, pageBody);
        }
    }

    private getPageUrls(pageBody: string, mainPageUrl: string): string[] {
        let result: string[] = [];
        const $ = cheerio.load(pageBody);
        $('ul.pagination a').each(function (i, elem) {
            const linkUrl = `${mainPageUrl}${elem.attribs['href']}`.replace(/([^:])[\/]+/g, "$1/");
            if (result.indexOf(linkUrl) < 0) {
                result.push(linkUrl);
            }
        });
        return result;
    }

    private async downloadPublicationsFromPage(request: any, pageBody: string) {
        const $ = cheerio.load(pageBody);
        for (let shelfBook of $('.shelf-book')) {
            let bookData = this.getPublicationsData($, shelfBook);
            console.log(`${new Date().toISOString()} - Found ${bookData.bookAuthorsTitle.title} - ${bookData.bookAuthorsTitle.authors}`);
            await this.downloadPublication(request, bookData);
        }
    }

    private getPublicationsData($: any, shelfBook: any) {
        let bookMetadata: { type: string, bookId: string, copyId: string, title: string } = this.getBookMetadata(shelfBook.attribs);
        const bookDetailsNode = $('.shelf-book-details', shelfBook);
        let bookAuthorsTitle: { authors: string, title: string } = this.getBookAuthorsAndTitle($, bookDetailsNode);
        let bookFormats: string[] = this.getBookFormats($, bookDetailsNode);
        return {bookMetadata, bookAuthorsTitle, bookFormats};
    }

    private getBookMetadata(attribs: any): { type: string, bookId: string, copyId: string, title: string } {
        return {
            type: attribs['data-type'],
            bookId: attribs['data-book-id'],
            copyId: attribs['data-copy-id'],
            title: attribs['data-book-title']
        };
    }

    private getBookAuthorsAndTitle($: any, bookDetails: any): { authors: string, title: string } {
        let title = $('h3', bookDetails).text();
        let authors = this.getBookAuthors($, bookDetails);
        return {authors: authors, title: title};
    }

    private getBookAuthors($: any, bookDetailsNode: any): string {
        let authors = "";
        for (let authorData of $('a[itemprop="author"]', bookDetailsNode)) {
            let author = authorData.children[0].data.trim();
            authors += `${author}, `;
        }
        return authors.replace(/, $/g, '').replace(/\s+/g, ' ');
    }

    private getBookFormats($: any, bookDetailsNode: any): string[] {
        let formatsString = "";
        for (let formats of $('p.formats span', bookDetailsNode)) {
            let format = formats.children[0].data.trim();
            formatsString += `${format}, `;
        }
        return formatsString.split(', ').filter(e => e.trim() != '');
    }

    private async downloadPublication(request: any, bookData: { bookFormats: string[]; bookMetadata: { type: string; bookId: string; copyId: string; title: string }; bookAuthorsTitle: { authors: string; title: string } }) {
        const bookName: string = `${bookData.bookAuthorsTitle.title} - ${bookData.bookAuthorsTitle.authors}`
        const downloadDir = `${this.booksDir}/${stringUtils.formatPathName(bookName)}`;
        if (!(await filesystemUtils.checkIfDirectoryExists(downloadDir))) {
            FS.mkdirSync(downloadDir);
        }
        for (let bookFormat of bookData.bookFormats) {
            const fileName = stringUtils.formatPathName(`${bookName}.${bookFormat}`);
            if (!(await filesystemUtils.checkIfElementExists(downloadDir, fileName))) {
                console.log(`${new Date().toISOString()} - Generating ${bookFormat} file for: ${bookData.bookAuthorsTitle.title} - ${bookData.bookAuthorsTitle.authors}`);
                if (await this.generatePublicationFiles(request, bookData.bookMetadata.copyId, bookFormat)) {
                    console.log(`${new Date().toISOString()} - Generated ${bookData.bookAuthorsTitle.title} - ${bookData.bookAuthorsTitle.authors}.${bookFormat}`);
                    await this.downloadPublicationFile(request, bookData.bookMetadata.copyId, downloadDir, fileName, bookFormat);
                } else {
                    console.log(`${new Date().toISOString()} - Could not generate ${bookData.bookAuthorsTitle.title} - ${bookData.bookAuthorsTitle.authors}.${bookFormat}`);
                }
            } else {
                console.log(`${new Date().toISOString()} - No need to download ${bookFormat} file for: ${bookData.bookAuthorsTitle.title} - ${bookData.bookAuthorsTitle.authors} - file already exists`);
            }
        }
    }

    private async generatePublicationFiles(request: any, copyId: string, bookFormat: string): Promise<boolean> {
        let responseObject: Object;
        let count: number = 0;
        try {
            do {
                const response: string = await this.sendGenerateRequest(request, copyId, bookFormat);
                if (response != undefined) {
                    responseObject = JSON.parse(response);
                    if (!responseObject['success']) {
                        console.log(`${new Date().toISOString()} - Error generating ${bookFormat} file - ${responseObject['errorMessage']}`);
                    }
                }
                if (response == undefined || !responseObject['ready']) {
                    console.log(`${new Date().toISOString()} - Waiting for ${bookFormat} file to be generated`);
                    await timingUtils.delayExactly(10 * ONE_SECOND);
                }
                count++
            } while (!responseObject['ready'] && count < 10);
            return responseObject['ready'];
        } catch (error) {
            return false;
        }
    }

    private async sendGenerateRequest(request: any, copyId: string, bookFormat: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const postRequestOptions = {
                method: "POST",
                form: {
                    copy_id: copyId,
                    format: bookFormat.toLowerCase()
                }
            };
            request.post(this.config.generateProductService, postRequestOptions)
                .then((response) => {
                    resolve(response);
                })
                .catch(error => {
//                    console.log(`${new Date().toISOString()} - Error generating ${bookFormat} file: ${error}`);
                    reject(error)
                })
        });
    }

    private async downloadPublicationFile(request: any, copyId: string, downloadDir: string, fileName: string, bookFormat: string) {
        const mapObj = {
            _copyId_: copyId,
            _fileFormat_: bookFormat.toLowerCase()
        };
        let downloadLink: string = this.config.downloadUrl.replace(/_copyId_|_fileFormat_/gi, function (matched) {
            return mapObj[matched];
        });
        return this.downloadFile(request, downloadLink, ONE_SECOND * 3, downloadDir, fileName);
    }
}
