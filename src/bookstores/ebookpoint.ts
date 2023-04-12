'use strict';

import * as cheerio from "cheerio";
import * as FS from "fs";
import * as iconv from "iconv-lite"
import {Bookstore} from "./bookstore";
import {filesystemUtils} from "../utils/filesystemUtils";
import {timingUtils} from "../utils/timingUtils";
import {stringUtils} from "../utils/stringUtils";

const FILE_EXTENSIONS = {
    mp3: 'zip',
    video: 'zip'
};

const GET_REQUEST_OPTIONS = {
    responseType: 'buffer',
    resolveWithFullResponse: true
};

const GET_OPTIONS = {
    resolveWithFullResponse: true
};

export class Ebookpoint extends Bookstore {
    protected notLoggedInRedirectUrlPart = "login";

    protected async checkIfUserIsLoggedIn(request: any): Promise<{ isLoggedIn: boolean, body: string }> {
        return new Promise((resolve, reject) => {
            request.get(this.config.bookshelfUrl, GET_REQUEST_OPTIONS)
                .then((response) => {
                    resolve({
                        isLoggedIn: (response.url == this.config.bookshelfUrl),
                        body: iconv.decode(Buffer.from(response.body), "ISO-8859-2")
                    });
                })
                .catch((error) => {
                    reject(`Could not check if ${this.config.login} is logged in. Error: ${error}`);
                })

        });
    }

    protected async logIn(request: any): Promise<string> {
        await this.visitLoginForm(request, this.config.loginFormUrl);
        console.log(`${new Date().toISOString()} - Logging in as ${this.config.login}`);

        const postRequestOptions = {
            resolveWithFullResponse: true,
            followRedirect: false,
            form: {
                gdzie: this.config.bookshelfUrl,
                edit: '',
                loginemail: this.config.login,
                haslo: this.config.password,
                remember: 1
            }
        };

        return new Promise((resolve, reject) => {
            request.post(this.config.loginServiceUrl, postRequestOptions)
                .then((response) => {
                    if (response.url == this.config.userIndexPageUrl) {
                        console.log(`${new Date().toISOString()} - Logged in as ${this.config.login}`);
                        request.get(this.config.bookshelfUrl, GET_REQUEST_OPTIONS)
                            .then((response) => resolve(iconv.decode(Buffer.from(response.body), "ISO-8859-2")))
                            .catch((error) => reject(`Could not get page contents for: ${this.config.bookshelfUrl}. Error: ${error}`));
                    } else {
                        reject(`Could not log in as ${this.config.login}`);
                    }
                })
                .catch((error) => {
                    reject(`Could not log in as ${this.config.login}. Error: ${error}`);
                })
        });
    }

    protected async getProducts(request: any, bookshelfPageBody: string) {
        await this.getProductsFromShelf(request, bookshelfPageBody, ".ebooki");
        console.log(`${new Date().toISOString()} - Getting books from archive`);
        const archivePageBody = await this.getPageBodyWithAdditionalOptions(request, this.config.archiveUrl, timingUtils.ONE_SECOND, false, GET_REQUEST_OPTIONS);
        await this.getProductsFromShelf(request, iconv.decode(Buffer.from(archivePageBody), "ISO-8859-2"), ".lista li");
    }

    protected async getProductsFromShelf(request: any, bookshelfPageBody: string, ebookElementSelector: string) {
        const $ = cheerio.load(bookshelfPageBody);
        for (let ebookListElement of $(ebookElementSelector)) {
            let productMetadata: { type: string, id: string, title: string, authors: string, controlValue: string, fileFormats: { format: string, status: string, troya: string }[] } =
                this.getBookMetadata($, ebookListElement);
            try {
                productMetadata.fileFormats = await this.getBookFileFormats(request, productMetadata.controlValue)
                if (productMetadata.fileFormats.length > 0) {
                    console.log(`${new Date().toISOString()} - Found ${productMetadata.fileFormats.map(format => format['format'])} filetypes for: ${productMetadata.title}`);

                    const elementName: string = `${productMetadata.title} - ${productMetadata.authors}`
                    const downloadDir = await this.createProductFolder(elementName);
                    for (let fileFormat of productMetadata.fileFormats) {
                        console.log(`${new Date().toISOString()} - Getting ${fileFormat['format']} file for: ${productMetadata.title} by ${productMetadata.authors}`);
                        if (fileFormat.troya != undefined) {
                            await this.downloadCourseFiles(request, productMetadata, fileFormat.format, fileFormat.troya, downloadDir);
                        } else {
                            await this.downloadFiles(request, productMetadata, fileFormat.format, this.checkIfReady(fileFormat.status), downloadDir);
                        }
                    }
                } else {
                    console.log(`${new Date().toISOString()} - Could not find any downloadable filetypes for: ${productMetadata.title}`);
                }
            } catch (error) {
                console.log(`${new Date().toISOString()} - Error getting product: ${error}`);
            }
        }
    }

    private async createProductFolder(bookName: string): Promise<string> {
        const downloadDir = `${this.booksDir}/${stringUtils.formatPathName(bookName)}`
            .replace('//', '/');
        if (!(await filesystemUtils.checkIfDirectoryExists(downloadDir))) {
            FS.mkdirSync(downloadDir);
        }
        return downloadDir;
    }

    private getBookMetadata($: any, ebookListElement: any): { type: string, id: string, title: string, authors: string, controlValue: string, fileFormats: { format: string, status: string, troya: string }[] } {
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
            controlValue: bookElementData[CONTROL_VALUE],
            fileFormats: []
        };
    }

    private getBookTitleAndAuthors($: any, ebookListElement: any) {
        let title = $("span.showModalTitle", ebookListElement)[0].children[0].data.trim().replace(/\.$/g, '');
        let authors = $("p.author", ebookListElement).text().trim().replace(/\.$/g, '');
        return {authors: authors, title: title};
    }

    private async downloadFiles(request: any, productMetadata: { type: string; id: string; title: string; authors: string; controlValue: string }, fileFormat: string, isReady: boolean, downloadDir: string) {
        const bookName: string = `${productMetadata.title} - ${productMetadata.authors}`
        const fileExtension = FILE_EXTENSIONS[fileFormat] !== undefined ? FILE_EXTENSIONS[fileFormat] : fileFormat;
        const fileName = stringUtils.formatPathName(`${bookName}.${fileExtension}`);
        if (!(await filesystemUtils.checkIfElementExists(downloadDir, fileName))) {
            let result: { ready: boolean, error: string };
            if (!isReady) {
                result = await this.generateProduct(request, productMetadata.id, productMetadata.controlValue, fileFormat);
            }
            if (isReady || result.ready) {
                console.log(`${new Date().toISOString()} - Files generated, downloading`);
                await this.checkFileSizeAndDownload(request, productMetadata.id, productMetadata.controlValue, downloadDir, fileName, fileFormat);
            } else {
                console.log(`${new Date().toISOString()} - Error downloading ${fileFormat} file for: ${productMetadata.title} - ${result.error}`);
            }
        } else {
            console.log(`${new Date().toISOString()} - No need to download ${fileFormat} file for: ${productMetadata.title} - ${productMetadata.authors} - file already exists`);
        }
    }

    private async downloadCourseFiles(request: any, productMetadata: { type: string; id: string; title: string; authors: string; controlValue: string }, fileFormat: string, troyaId: string, downloadDir: string) {
        const courseName: string = `${productMetadata.title} - ${productMetadata.authors}`
        const fileExtension = FILE_EXTENSIONS[fileFormat] !== undefined ? FILE_EXTENSIONS[fileFormat] : fileFormat;
        const fileName = stringUtils.formatPathName(`${courseName}.${fileExtension}`);
        if (!(await filesystemUtils.checkIfElementExists(downloadDir, fileName))) {
            await this.downloadCourseFile(request, productMetadata.controlValue, troyaId, downloadDir, fileName);
        } else {
            console.log(`${new Date().toISOString()} - No need to download ${fileFormat} file for: ${productMetadata.title} - ${productMetadata.authors} - file already exists`);
        }
    }

    private async generateProduct(request: any, id: string, controlValue: string, fileFormat: string): Promise<{ ready: boolean, error: string }> {
        const mapObj = {
            _bookId_: id,
            _fileFormat_: fileFormat,
            _control_: controlValue
        };
        let downloadLink: string = this.config.generateProductServiceUrl.replace(/_bookId_|_control_|_fileFormat_/gi, function (matched) {
            return mapObj[matched];
        });
        await this.getPageBody(request, downloadLink, timingUtils.ONE_SECOND * 5);
        console.log(`${new Date().toISOString()} - Product preparation started`);
        return await this.waitUntilPrepared(request, downloadLink);
    }

    private async waitUntilPrepared(request: any, statusLink: string): Promise<{ ready: boolean; fileFormats: string[]; error: string }> {
        console.log(statusLink);
        let count: number = 0;
        let ready: boolean = false;
        let notHandled: boolean = false;
        const MAX_RETRY = 30;
        try {
            let fileFormats: string[] = [];
            do {
                const response: string = await this.getPageBodyWithAdditionalOptions(request, statusLink, 0, true, GET_OPTIONS);
                if (response != undefined) {
                    const responseData = JSON.parse(response);
                    console.log(`${new Date().toISOString()} - Waiting for files to be generated - current attempt:${count}, status: ${responseData.status}`);
                    if (responseData['status'] != null) {
                        ready = this.checkIfReady(responseData['status']);
                    } else {
                        notHandled = true;
                    }
                }
                count++;
                if (!ready && !notHandled) {
                    await timingUtils.delayExactly(timingUtils.ONE_SECOND * 10);
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

    private checkIfReady(dataStatus: string): boolean {
        return this.config.statusGenerated === dataStatus;
    }

    private async checkFileSizeAndDownload(request: any, id: string, controlValue: string, downloadDir: string, fileName: string, fileFormat: string): Promise<any> {
        const mapObj = {
            _bookId_: id,
            _control_: controlValue,
            _fileFormat_: fileFormat
        };
        let downloadLink: string = this.config.downloadUrl.replace(/_bookId_|_control_|_fileFormat_/gi, function (matched) {
            return mapObj[matched];
        });

        return this.downloadFile(request, downloadLink, timingUtils.ONE_SECOND * 4, downloadDir, fileName);
    }

    private async downloadCourseFile(request: any, controlValue: string, troyaId: string, downloadDir: string, fileName: string): Promise<any> {
        const mapObj = {
            _control_: controlValue,
            _troyaId_: troyaId
        };
        let downloadLink: string = this.config.courseDownloadUrl.replace(/_control_|_troyaId_/gi, function (matched) {
            return mapObj[matched];
        });

        return this.downloadFile(request, downloadLink, timingUtils.ONE_SECOND * 4, downloadDir, fileName);
    }

    private async getBookFileFormats(request: any, controlValue: string): Promise<{ format: string, status: string, troya: string }[]> {
        let pageUrl: string = this.config.getBookDetailsServiceUrl.replace('_control_', controlValue);
        let bookDetailsResponse = await this.getPageBody(request, pageUrl, timingUtils.ONE_SECOND)
        let bookDetailsJson = JSON.parse(bookDetailsResponse);
        return bookDetailsJson['dane']['formaty']
            .map(fmt => this.mapToFormatData(fmt, bookDetailsJson['dane']['troya']));
    }

    private mapToFormatData(fmt: any, videoId: any): { format: string; status: string; troya: string } {
        return {
            format: fmt['format_name'],
            status: fmt['status'],
            troya: fmt['format_name'] === 'video' ? videoId : undefined
        };
    }
}
