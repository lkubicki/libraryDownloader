'use strict';

import * as cheerio from "cheerio";
import * as FS from "fs";
import {Bookstore} from "./bookstore";
import {filesystemUtils} from "../utils/filesystemUtils";
import {timingUtils} from "../utils/timingUtils";
import {stringUtils} from "../utils/stringUtils";

export class Woblink extends Bookstore {
    protected notLoggedInRedirectUrlPart: string = "logowanie";

    protected async logIn(request: any): Promise<string> {
        await this.visitLoginForm(request, this.config.loginFormUrl);
        console.log(`${new Date().toISOString()} - Logging in as ${this.config.login}`);
        const loginRequestOptions = {
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
        return this.sendLoginForm(request, loginRequestOptions);
    }

    protected async getProducts(request: any, bookshelfPageBody: string) {
        let pageUrls: string[] = this.getPageUrls(bookshelfPageBody, this.config.mainPageUrl);
        console.log(`${new Date().toISOString()} - Found ${pageUrls.length + 1} bookshelf ` + (pageUrls.length >= 1 ? `pages` : `page`));
        let pageBody = bookshelfPageBody;
        await this.downloadPublicationsFromPage(request, pageBody);
        for (let shelfPageUrl of pageUrls) {
            console.log(`${new Date().toISOString()} - Changing page to: ${shelfPageUrl}`);
            pageBody = await this.getPageBody(request, shelfPageUrl, timingUtils.ONE_SECOND);
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
            try {
                let bookData = await this.getPublicationsData(request, $, shelfBook);
                console.log(`${new Date().toISOString()} - Found ${bookData.bookTitle} - ${bookData.bookAuthors}`);
                await this.downloadPublication(request, bookData);
            } catch (error) {
                console.log(`${new Date().toISOString()} - ${error}`);
            }
        }
    }

    private async getPublicationsData(request: any, $: any, shelfBook: any): Promise<{ bookId: string, copyId: string, bookAuthors: string, bookTitle: string, bookFormats: string[] }> {
        const bookId = shelfBook.attribs['data-book-id'];
        const bookMetadataText: string = await this.getPageBody(request, this.config.metadataUrl.replace("_bookId_", bookId), timingUtils.ONE_SECOND);
        const bookMetadataObject = JSON.parse(bookMetadataText);
        let bookAuthors: string = this.getBookAuthors(bookMetadataObject['authors']);
        let bookFormats: string[] = this.getBookFormats(bookMetadataObject['downloads']);
        return {
            bookId: bookId,
            copyId: bookMetadataObject.copyId,
            bookAuthors: bookAuthors,
            bookTitle: bookMetadataObject['title'],
            bookFormats: bookFormats
        };
    }

    private getBookAuthors(authorsData: { fullname: string, uri: string }[]): string {
        let authors: string = "";
        for (let authorData of authorsData) {
            let author = authorData.fullname.trim();
            authors += `${author}, `;
        }
        return authors.replace(/, $/g, '').replace(/\s+/g, ' ');
    }

    private getBookFormats(bookFormats: any): string[] {
        let formats = [];
        for (let format of Object.keys(bookFormats)) {
            formats.push(format);
        }
        return formats;
    }

    private async downloadPublication(request: any, bookData: { bookFormats: string[]; bookId: string; copyId: string; bookTitle: string, bookAuthors: string }) {
        const bookName: string = `${bookData.bookTitle} - ${bookData.bookAuthors}`
        const downloadDir = `${this.booksDir}/${stringUtils.formatPathName(bookName)}`;
        if (!(await filesystemUtils.checkIfDirectoryExists(downloadDir))) {
            FS.mkdirSync(downloadDir);
        }
        for (let bookFormat of bookData.bookFormats) {
            const fileName = stringUtils.formatPathName(`${bookName}.${bookFormat}`);
            if (!(await filesystemUtils.checkIfElementExists(downloadDir, fileName))) {
                console.log(`${new Date().toISOString()} - Generating ${bookFormat} file for: ${bookData.bookTitle} - ${bookData.bookAuthors}`);
                if (await this.generatePublicationFiles(request, bookData.copyId, bookFormat)) {
                    console.log(`${new Date().toISOString()} - Generated ${bookData.bookTitle} - ${bookData.bookAuthors}.${bookFormat}`);
                    await this.downloadPublicationFile(request, bookData.copyId, downloadDir, fileName, bookFormat);
                } else {
                    console.log(`${new Date().toISOString()} - Could not generate ${bookData.bookTitle} - ${bookData.bookAuthors}.${bookFormat}`);
                }
            } else {
                console.log(`${new Date().toISOString()} - No need to download ${bookFormat} file for: ${bookData.bookTitle} - ${bookData.bookAuthors} - file already exists`);
            }
        }
    }

    private async generatePublicationFiles(request: any, copyId: string, bookFormat: string): Promise<boolean> {
        let responseObject: Object;
        let count: number = 0;
        try {
            do {
                const response: string = await this.sendGenerateRequest(request, copyId, bookFormat)
                if (response != undefined) {
                    responseObject = JSON.parse(response);
                    if (!responseObject['success']) {
                        console.log(`${new Date().toISOString()} - Error generating ${bookFormat} file - ${responseObject['errorMessage']}`);
                    }
                }
                if (response == undefined || !responseObject['ready']) {
                    console.log(`${new Date().toISOString()} - Waiting for ${bookFormat} file to be generated`);
                    await timingUtils.delayExactly(10 * timingUtils.ONE_SECOND);
                }
                count++
            } while (!responseObject['ready'] && count < 10);
            return responseObject['ready'];
        } catch (error) {
            console.log(`${new Date().toISOString()} - ${error}`);
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
                    reject(`Error generating ${bookFormat} file: ${error}`)
                })
        });
    }

    private async downloadPublicationFile(request: any, copyId: string, downloadDir: string, fileName: string, bookFormat: string): Promise<any> {
        const mapObj = {
            _copyId_: copyId,
            _fileFormat_: bookFormat.toLowerCase()
        };
        let downloadLink: string = this.config.downloadUrl.replace(/_copyId_|_fileFormat_/gi, function (matched) {
            return mapObj[matched];
        });
        return this.downloadFile(request, downloadLink, timingUtils.ONE_SECOND * 3, downloadDir, fileName);
    }
}
