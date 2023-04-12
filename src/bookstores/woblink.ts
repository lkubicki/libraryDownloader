'use strict';

import * as cheerio from "cheerio";
import * as FS from "fs";
import {Bookstore} from "./bookstore";
import {filesystemUtils} from "../utils/filesystemUtils";
import {timingUtils} from "../utils/timingUtils";
import {stringUtils} from "../utils/stringUtils";

export class Woblink extends Bookstore {
    protected notLoggedInRedirectUrlPart = "logowanie";

    protected async logIn(request: any): Promise<string> {
        const pageBody = await this.visitLoginForm(request, this.config.loginFormUrl);
        const csrfToken = this.findCsrfTokenValue(pageBody);
        console.log(`${new Date().toISOString()} - Logging in as ${this.config.login}`);
        const loginRequestOptions = {
            resolveWithFullResponse: true,
            method: "POST",
            form: {
                _username: this.config.login,
                _password: this.config.password,
                _go_back_to: this.config.bookshelfUrl,
                _csrf_token: csrfToken
            }
        };
        return this.sendLoginForm(request, loginRequestOptions);
    }

    protected async getProducts(request: any, bookshelfPageBody: string) {
        let page = 1
        let booksList = undefined;
        try {
            do {
                const pageUrl = this.config.bookshelfContentUrl.replace("_page_", page);
                console.log(`${new Date().toISOString()} - Downloading publications from page: ${pageUrl}`);
                booksList = JSON.parse(await this.getPageBody(request, pageUrl, 1));
                for (let publication of booksList.publications) {
                    let bookData = {
                        bookDownloads: [],
                        bookId: publication.uid,
                        copyId: publication.copyId,
                        bookTitle: publication.title,
                        bookAuthors: this.getBookAuthors(publication.contributors)
                    }
                    for (let format of publication.format) {
                        bookData.bookDownloads.push({
                            fileFormat: format,
                            downloadUrl: publication.downloads[format.toLowerCase()]
                        })
                    }
                    await this.downloadPublication(request, bookData)
                }
                page++;
            } while (page <= booksList.totalPages)
        } catch (error) {
            console.log(`${new Date().toISOString()} - ${error}`);
        }
    }

    private getBookAuthors(authors: string): string {
        return authors.replace(/, $/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private async downloadPublication(request: any, bookData: { bookDownloads: any[]; bookId: string; copyId: string; bookTitle: string, bookAuthors: string }) {
        const bookName: string = `${bookData.bookTitle} - ${bookData.bookAuthors}`
        const downloadDir = `${this.booksDir}/${stringUtils.formatPathName(bookName)}`;
        if (!(await filesystemUtils.checkIfDirectoryExists(downloadDir))) {
            FS.mkdirSync(downloadDir);
        }
        for (let downloadData of bookData.bookDownloads) {
            const fileName = stringUtils.formatPathName(`${bookName}.${downloadData.fileFormat}`);
            if (!(await filesystemUtils.checkIfElementExists(downloadDir, fileName))) {
                console.log(`${new Date().toISOString()} - Generating ${downloadData.fileFormat} file for: ${bookData.bookTitle} - ${bookData.bookAuthors}`);
                if (await this.generatePublicationFiles(request, bookData.copyId, downloadData.fileFormat, downloadData.downloadUrl)) {
                    console.log(`${new Date().toISOString()} - Generated ${bookData.bookTitle} - ${bookData.bookAuthors}.${downloadData.fileFormat}`);
                    await this.downloadPublicationFile(request, bookData.copyId, downloadDir, fileName, downloadData.fileFormat, downloadData.downloadUrl);
                } else {
                    console.log(`${new Date().toISOString()} - Could not generate ${bookData.bookTitle} - ${bookData.bookAuthors}.${downloadData.fileFormat}`);
                }
            } else {
                console.log(`${new Date().toISOString()} - No need to download ${downloadData.fileFormat} file for: ${bookData.bookTitle} - ${bookData.bookAuthors} - file already exists`);
            }
        }
    }

    private async generatePublicationFiles(request: any, copyId: string, bookFormat: string, downloadUrl: String): Promise<boolean> {
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
                    resolve(response.body);
                })
                .catch(error => {
                    reject(`Error generating ${bookFormat} file: ${error}`)
                })
        });
    }

    private async downloadPublicationFile(request: any, copyId: string, downloadDir: string, fileName: string, bookFormat: string, downloadUrl: any): Promise<any> {
        const mapObj = {
            _copyId_: copyId,
            _fileFormat_: bookFormat.toLowerCase()
        };

        let downloadLink: string = this.config.downloadUrl.replace(/_copyId_|_fileFormat_/gi, function (matched) {
            return mapObj[matched];
        });
        return this.downloadFile(request, downloadLink, timingUtils.ONE_SECOND * 3, downloadDir, fileName);
    }

    private findCsrfTokenValue(pageBody: string) {
        let $ = cheerio.load(pageBody);
        return $('form.login-page__form input[name="_csrf_token"]').val();
    }
}
