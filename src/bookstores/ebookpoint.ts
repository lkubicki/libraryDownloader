'use strict';

import * as cheerio from "cheerio";
import * as FS from "fs";
import * as iconv from "iconv-lite"
import {Bookstore} from "./bookstore";
import {filesystemUtils} from "../utils/filesystemUtils";
import {timingUtils} from "../utils/timingUtils";
import {stringUtils} from "../utils/stringUtils";

const ONE_SECOND: number = 1000;

export class Ebookpoint extends Bookstore {
    protected notLoggedInRedirectUrlPart: string = "login";

    protected async checkIfUserIsLoggedIn(request: any): Promise<{ isLoggedIn: boolean, body: string }> {
        const getRequestOptions = {
            encoding: null,
            resolveWithFullResponse: true
        };
        return new Promise((resolve) => {
            request.get(this.config.bookshelfUrl, getRequestOptions)
                .then((response) => {
                    resolve({
                        isLoggedIn: (response.request.uri.href == this.config.bookshelfUrl),
                        body: iconv.decode(Buffer.from(response.body), "ISO-8859-2")
                    });
                });
        });
    }

    protected async logIn(request: any): Promise<string> {
        await this.visitLoginForm(request, this.config.loginFormUrl);
        console.log(`${new Date().toISOString()} - Logging in as ${this.config.login}`);
        return new Promise((resolve, reject) => {
            const postRequestOptions = {
                resolveWithFullResponse: true,
                method: "POST",
                form: {
                    gdzie: this.config.bookshelfUrl,
                    edit: '',
                    loginemail: this.config.login,
                    haslo: this.config.password
                }
            };
            request.post(this.config.loginServiceUrl, postRequestOptions)
                .then((response) => {
                    if (response.request.uri.href == this.config.bookshelfUrl) {
                        console.log(`${new Date().toISOString()} - Logged in as ${this.config.login}`);
                        const getRequestOptions = {
                            encoding: null
                        };
                        request.get(this.config.bookshelfUrl, getRequestOptions)
                            .then((body) => resolve(iconv.decode(Buffer.from(body), "ISO-8859-2")));
                    } else {
                        reject(`Could not log in as ${this.config.login}`);
                    }
                })
        });
    }

    protected async getProducts(request: any, bookshelfPageBody: string) {
        await this.getProductsFromShelf(request, bookshelfPageBody, ".ebooki");
        console.log(`${new Date().toISOString()} - Getting books from archive`);
        const archivePageBody = await this.getPageBodyWithAdditionalOptions(request, this.config.archiveUrl, ONE_SECOND, false, {encoding: null});
        await this.getProductsFromShelf(request, iconv.decode(Buffer.from(archivePageBody), "ISO-8859-2"), ".lista li");
    }

    protected async getProductsFromShelf(request: any, bookshelfPageBody: string, ebookElementSelector: string) {
        const $ = cheerio.load(bookshelfPageBody);
        for (let ebookListElement of $(ebookElementSelector)) {
            try {
                const productMetadata: { type: string, id: string, title: string, authors: string, controlValue: string } =
                    this.getBookMetadata($, ebookListElement);
                console.log(`${new Date().toISOString()} - Preparing files for: ${productMetadata.title} by ${productMetadata.authors}`);
                const generateResponse = await this.generateProduct(request, productMetadata.controlValue, productMetadata.id);
                if (generateResponse.ready) {
                    console.log(`${new Date().toISOString()} - Files for: ${productMetadata.title} by ${productMetadata.authors} generated. Downloading.`);
                    await this.downloadFiles(request, productMetadata, generateResponse.fileFormats);
                } else {
                    console.log(`${new Date().toISOString()} - Could not prepare files for: ${productMetadata.title} by ${productMetadata.authors} - ${generateResponse.error}`);
                }
            } catch (error) {
                console.log(`${new Date().toISOString()} - Error getting product: ${error}`);
            }
        }
    }

    private getBookMetadata($: any, ebookListElement: any): { type: string, id: string, title: string, authors: string, controlValue: string } {
        const CONTROL_VALUE: number = 0;
        const PRODUCT_TYPE: number = 1;
        const PRODUCT_ID = 2;
        let bookTitleAndAuthors: { title: string, authors: string } = this.getBookTitleAndAuthors($, ebookListElement);
        let bookElementData: string[] = [];
        for (let coverParagraph of $("p.cover", ebookListElement)) {
            bookElementData = coverParagraph.attribs['onclick']
                .replace(/modal.showModal\(|\)|'/g, '')
                .split(',');
        }
        return {
            type: bookElementData[PRODUCT_TYPE].toLowerCase(),
            id: bookElementData[PRODUCT_ID],
            title: bookTitleAndAuthors.title,
            authors: bookTitleAndAuthors.authors,
            controlValue: bookElementData[CONTROL_VALUE]
        };
    }

    private getBookTitleAndAuthors($: any, ebookListElement: any) {
        let title = $("span.showModalTitle", ebookListElement)[0].children[0].data.trim();
//        let title = $("h3.title", ebookListElement).text().trim();
        let authors = $("p.author", ebookListElement).text().trim();
        return {authors: authors, title: title};
    }

    private async generateProduct(request: any, controlValue: string, id: string): Promise<{ ready: boolean, fileFormats: string[], error: string }> {
        const mapObj = {
            _bookId_: id,
            _control_: controlValue
        };
        let downloadLink: string = this.config.generateProductServiceUrl.replace(/_bookId_|_control_/gi, function (matched) {
            return mapObj[matched];
        });
        await this.getPageBody(request, downloadLink, ONE_SECOND * 5);
        console.log(`${new Date().toISOString()} - Product preparation started`);
        return await this.waitUntilPrepared(request, controlValue);
    }

    private async waitUntilPrepared(request: any, controlValue: string): Promise<{ ready: boolean; fileFormats: string[]; error: string }> {
        let count: number = 0;
        let ready: boolean = false;
        let notHandled: boolean = false;
        const statusLink = this.config.generateProductStatusServiceUrl.replace('_control_', controlValue);
        const MAX_RETRY = 20;
        try {
            let fileFormats: string[] = [];
            do {
                console.log(`${new Date().toISOString()} - Waiting for files to be generated`);
                const response: string = await this.getPageBodyWithAdditionalOptions(request, statusLink, 0, true, {encoding: null});
                if (response != undefined) {
                    const responseData = JSON.parse(response);
                    if (responseData['frm'] != null) {
                        ready = this.checkIfReady(responseData);
                        if (ready) {
                            fileFormats = this.getFileFormats(responseData);
                        }
                    } else {
                        notHandled = true;
                    }
                }
                count++;
                if (!ready && !notHandled) {
                    await timingUtils.delayExactly(ONE_SECOND * 10);
                }
            } while (!ready && count < MAX_RETRY && !notHandled);
            return {
                ready: ready,
                fileFormats: fileFormats,
                error: count >= MAX_RETRY ? `Gave up after asking ${MAX_RETRY} times` : ''
            };
        } catch (error) {
            return {ready: false, fileFormats: [], error: error};
        }
    }

    private checkIfReady(responseData: any): boolean {
        let ready: boolean = true;
        for (let fmt of responseData['frm']) {
            ready = ready && fmt['clas'] == 'pobierz'
        }
        return ready;
    }

    private getFileFormats(responseData: any): string[] {
        let formats: string[] = [];
        for (let fmt of responseData['frm']) {
            if (formats.indexOf(fmt['ext']) < 0) {
                formats.push(fmt['ext']);
            }
        }
        return formats;
    }

    private async downloadFiles(request: any, productMetadata: { type: string; id: string; title: string; authors: string; controlValue: string }, fileFormats: string[]) {
        const bookName: string = `${productMetadata.title} - ${productMetadata.authors}`
        const downloadDir = `${this.booksDir}/${stringUtils.formatPathName(bookName)}`;
        if (!(await filesystemUtils.checkIfDirectoryExists(downloadDir))) {
            FS.mkdirSync(downloadDir);
        }
        for (let fileFormat of fileFormats) {
            const fileName = stringUtils.formatPathName(`${bookName}.${fileFormat}`);
            if (!(await filesystemUtils.checkIfElementExists(downloadDir, fileName))) {
                await this.checkFileSizeAndDownload(request, productMetadata.id, productMetadata.controlValue, downloadDir, fileName, fileFormat);
            } else {
                console.log(`${new Date().toISOString()} - No need to download ${fileFormat} file for: ${productMetadata.title} - ${productMetadata.authors} - file already exists`);
            }
        }
    }

    private async checkFileSizeAndDownload(request: any, id: string, controlValue: string, downloadDir: string, fileName: string, fileFormat: string) {
        const mapObj = {
            _bookId_: id,
            _control_: controlValue,
            _fileFormat_: fileFormat
        };
        let downloadLink: string = this.config.downloadUrl.replace(/_bookId_|_control_|_fileFormat_/gi, function (matched) {
            return mapObj[matched];
        });

        return this.checkSizeAndDownloadFile(request, downloadLink, ONE_SECOND * 4, downloadDir, fileName);
    }
}
