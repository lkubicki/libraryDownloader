'use strict';

import * as cheerio from "cheerio";
import * as FS from "fs";
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
    resolveWithFullResponse: true,
    followAllRedirects: true,
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
                        body: response.body
                    });
                })
                .catch((error) => {
                    reject(`Could not check if ${this.config.login} is logged in. Error: ${error}`);
                })

        });
    }

    protected async logIn(request: any): Promise<string> {
        var pageBody = await this.visitLoginForm(request, this.config.loginFormUrl);
        var token = this.fetchCsrfToken(pageBody);
        console.log(`${new Date().toISOString()} - Logging in as ${this.config.login}`);

        const postRequestOptions = {
            resolveWithFullResponse: true,
            followAllRedirects: true,
            allowGetBody: true,
            methodRewriting: false,
            form: {
                csrf_token: token,
                email: this.config.login,
                password: this.config.password,
                target_path: ""
            },
            headers: {
                host: "ebookpoint.pl",
                origin: this.config.mainPageUrl
            }
        };

        return new Promise((resolve, reject) => {
            request.post(this.config.loginServiceUrl, postRequestOptions)
                .then((response) => {
                    request.get(this.config.bookshelfUrl, GET_REQUEST_OPTIONS)
                        .then((response) => {
                            if (response.url.indexOf(this.notLoggedInRedirectUrlPart) > 0) {
                                reject(`Could not log in as ${this.config.login}`);
                            } else {
                                console.log(`${new Date().toISOString()} - Logged in as ${this.config.login}`);
                                resolve(response.body)
                            }
                        })
                        .catch((error) => reject(`Could not get page contents for: ${this.config.bookshelfUrl}. Error: ${error}`));
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
        await this.getProductsFromShelf(request, archivePageBody, ".lista li");
    }

    protected async getProductsFromShelf(request: any, bookshelfPageBody: string, ebookElementSelector: string) {
        const $ = cheerio.load(bookshelfPageBody);
        for (let ebookListElement of $(ebookElementSelector)) {
            let productMetadata: {
                type: string,
                id: string,
                title: string,
                authors: string,
                controlValue: string,
                fileFormats: { format: string, status: string, troya: string }[]
            } =
                this.getBookMetadata($, ebookListElement);
            if (productMetadata.controlValue != undefined) {
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
            } else {
                console.log(`${new Date().toISOString()} - Could not download: ${productMetadata.title} - no control data`);
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

    private getBookMetadata($: any, ebookListElement: any): {
        type: string,
        id: string,
        title: string,
        authors: string,
        controlValue: string,
        fileFormats: { format: string, status: string, troya: string }[]
    } {
        const CONTROL_VALUE: number = 0;
        const PRODUCT_TYPE: number = 1;
        const PRODUCT_ID = 2;
        let bookTitleAndAuthors: { title: string, authors: string } = this.getBookTitleAndAuthors($, ebookListElement);
        let bookElementData: string[] = [];
        for (let coverParagraph of $("p.cover", ebookListElement)) {
            bookElementData = coverParagraph.attribs['onclick']
                .replace(/modal.showModal3\([a-zA-Z0-9\'\",_\s-']+\);/g, '')
                .replace(/modal.showModal\(|\);|'/g, '')
                .replace(/library.modal\(|\)|;|'/g, '')
                .replace(/[\s]*return false;[\s]*"/g, '')
                .split(',');
        }
        return {
            type: bookElementData[PRODUCT_TYPE].trim(),
            id: bookElementData[PRODUCT_ID] != undefined ? bookElementData[PRODUCT_ID].trim() : null,
            title: bookTitleAndAuthors.title.trim(),
            authors: bookTitleAndAuthors.authors,
            controlValue: this.getControlValue(bookElementData[CONTROL_VALUE]),
            fileFormats: []
        };
    }

    private getControlValue(bookElementControlValue: string): string {
        return bookElementControlValue.indexOf("libraryCourses") >= 0 ? undefined : bookElementControlValue;
    }

    private getBookTitleAndAuthors($: any, ebookListElement: any) {
        let title = $("span.showModalTitle", ebookListElement)[0].children[0].data.trim().replace(/\.$/g, '');
        let authors = $("p.author", ebookListElement).text().trim().replace(/\.$/g, '');
        return {authors: authors, title: title};
    }

    private async downloadFiles(request: any, productMetadata: {
        type: string;
        id: string;
        title: string;
        authors: string;
        controlValue: string
    }, fileFormat: string, isReady: boolean, downloadDir: string) {
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
                await this.checkFileSizeAndDownload(request, productMetadata.type, productMetadata.controlValue, downloadDir, fileName, fileFormat);
            } else {
                console.log(`${new Date().toISOString()} - Error downloading ${fileFormat} file for: ${productMetadata.title} - ${result.error}`);
            }
        } else {
            console.log(`${new Date().toISOString()} - No need to download ${fileFormat} file for: ${productMetadata.title} - ${productMetadata.authors} - file already exists`);
        }
    }

    private async downloadCourseFiles(request: any, productMetadata: {
        type: string;
        id: string;
        title: string;
        authors: string;
        controlValue: string
    }, fileFormat: string, troyaId: string, downloadDir: string) {
        const courseName: string = `${productMetadata.title} - ${productMetadata.authors}`
        const fileExtension = FILE_EXTENSIONS[fileFormat] !== undefined ? FILE_EXTENSIONS[fileFormat] : fileFormat;
        const fileName = stringUtils.formatPathName(`${courseName}.${fileExtension}`);
        if (!(await filesystemUtils.checkIfElementExists(downloadDir, fileName))) {
            await this.downloadCourseFile(request, productMetadata.controlValue, troyaId, downloadDir, fileName);
        } else {
            console.log(`${new Date().toISOString()} - No need to download ${fileFormat} file for: ${productMetadata.title} - ${productMetadata.authors} - file already exists`);
        }
    }

    private async generateProduct(request: any, id: string, controlValue: string, fileFormat: string): Promise<{
        ready: boolean,
        error: string
    }> {
        const mapObj = {
            _bookId_: id.replace(/_EBOOK/g, '').toLowerCase(),
            _fileFormat_: fileFormat,
            _control_: controlValue
        };
        let downloadLink: string = this.config.generateProductServiceUrl.replace(/_bookId_|_control_|_fileFormat_/gi, function (matched) {
            return mapObj[matched];
        });
        await this.getPageBodyWithAdditionalOptions(request, downloadLink, timingUtils.ONE_SECOND * 5, false, {
            resolveWithFullResponse: true,
            headers: {
                Host: "ebookpoint.pl"
            }
        });
        console.log(`${new Date().toISOString()} - Product preparation started`);
        return await this.waitUntilPrepared(request, downloadLink);
    }

    private async waitUntilPrepared(request: any, statusLink: string): Promise<{
        ready: boolean;
        fileFormats: string[];
        error: string
    }> {
        let count: number = 0;
        let ready: boolean = false;
        let notHandled: boolean = false;
        const MAX_RETRY = 30;
        try {
            let fileFormats: string[] = [];
            do {
                const options = {
                    resolveWithFullResponse: true,
                    headers: {
                        Host: "ebookpoint.pl"
                    }
                };
                const response: string = await this.getPageBodyWithAdditionalOptions(request, statusLink, 0, true, options);
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

    private async getBookFileFormats(request: any, controlValue: string): Promise<{
        format: string,
        status: string,
        troya: string
    }[]> {
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

    private fetchCsrfToken(pageBody: string): string {
        const $ = cheerio.load(pageBody);
        return $('[name=csrf_token]').val() as string;
    }
}
