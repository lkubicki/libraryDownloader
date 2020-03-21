'use strict';

import * as cheerio from "cheerio";
import * as FS from "fs";
import * as xml2js from "xml2js"
import {Bookstore} from "./bookstore";
import {filesystemUtils} from "../utils/filesystemUtils";
import {timingUtils} from "../utils/timingUtils";
import {stringUtils} from "../utils/stringUtils";

const ONE_SECOND: number = 1000;

export class InformIT extends Bookstore {
    protected notLoggedInRedirectUrlPart: string = "login.aspx";

    protected async checkIfUserIsLoggedIn(request: any): Promise<{ isLoggedIn: boolean, body: string }> {
        const getRequestOptions = {
            resolveWithFullResponse: true
        };
        return new Promise((resolve) => {
            request.get(this.config.bookshelfUrl, getRequestOptions)
                .then((response) => {
                    resolve({
                        isLoggedIn: response.request.uri.href.indexOf(this.notLoggedInRedirectUrlPart) < 0,
                        body: response.body
                    });
                });
        });
    }

    protected async logIn(request: any): Promise<string> {
        await this.visitLoginForm(request, this.config.loginFormUrl);
        console.log(`${new Date().toISOString()} - Logging in as ${this.config.login}`);
        return new Promise((resolve, reject) => {
            const postRequestOptions = {
                headers: {
                    origin: this.config.mainServiceUrl,
                    referer: this.config.bookshelfUrl
                },
                form: {
                    email_address: this.config.login,
                    password: this.config.password
                }
            };
            request.post(this.config.loginServiceUrl, postRequestOptions)
                .then((response) => {
                    this.checkIfUserIsLoggedIn(request).then((checkResult) => {
                        if (checkResult.isLoggedIn) {
                            console.log(`${new Date().toISOString()} - Logged in as ${this.config.login}`);
                            resolve(checkResult.body);
                        } else {
                            reject(`Could not log in as ${this.config.login}`);
                        }
                    });
                })
        });
    }

    private async visitLoginForm(request: any, loginFormUrl: string) {
        return new Promise((resolve, reject) => {
            request.get(loginFormUrl)
                .then((body: string) => {
                    timingUtils.delay(ONE_SECOND).then(() => {
                        resolve();
                    });
                })
        });
    }

    protected async getProducts(request: any, bookshelfPageBody: string) {
        const $ = cheerio.load(bookshelfPageBody);
        for (let ebookListElement of $("dl.rFull")) {
            try {
                const title: string = this.getBookTitle($, ebookListElement);
                console.log(`${new Date().toISOString()} - Found: "${title}"`);
                const refreshLinks: { ready: boolean, downloadLink: string, isbn13: string, nid: string, fileType: string }[] =
                    this.getRefreshLinks($, ebookListElement);
                for (let refreshLink of refreshLinks) {
                    if (!refreshLink.ready) {
                        if (refreshLink.isbn13 != null && refreshLink.nid != null && refreshLink.fileType != null) {
                            const fileName = stringUtils.formatPathName(title);
                            const downloadDir = `${this.booksDir}${fileName}`;
                            if (!(await filesystemUtils.checkIfElementExists(downloadDir, `${fileName}.${refreshLink.fileType}`))) {
                                await timingUtils.delay(ONE_SECOND * 2);
                                const generateResponse = await this.generateProduct(request, refreshLink.isbn13, refreshLink.nid, refreshLink.fileType);
                                if (generateResponse.ready) {
                                    console.log(`${new Date().toISOString()} - ${refreshLink.fileType} files for: ${title} generated. Downloading.`);
                                    const downloadLink = this.prepareDownloadLink(refreshLink.isbn13, refreshLink.fileType, refreshLink.nid);
                                    await this.checkSizeAndDownloadBook(request, downloadLink, title, refreshLink.fileType);
                                } else {
                                    console.log(`${new Date().toISOString()} - Could not prepare ${refreshLink.fileType} file for: ${title} - ${generateResponse.error}`);
                                }
                            } else {
                                console.log(`${new Date().toISOString()} - No need to download ${refreshLink.fileType} file for: ${title} - file already exists`);
                            }
                        }
                    } else {
                        await this.checkSizeAndDownloadBook(request, refreshLink.downloadLink, title, refreshLink.fileType);
                    }
                }
            } catch (error) {
                console.log(`${new Date().toISOString()} - Error getting product: ${error}`);
            }
        }
    }

    private getBookTitle($: any, ebookListElement: any): string {
        return $("dt", ebookListElement).text();
    }

    private prepareDownloadLink(isbn13: string, fileFormat: string, nid: string): string {
        const mapObj = {
            _fileFormat_: fileFormat,
            _isbn_: isbn13,
            _nid_: nid
        };
        return this.config.downloadServiceUrl.replace(/_fileFormat_|_isbn_|_nid_/gi, function (matched) {
            return mapObj[matched];
        });
    }

    private getRefreshLinks($: any, ebookListElement: any): { ready: boolean, downloadLink: string, isbn13: string, nid: string, fileType: string }[] {
        let result: { ready: boolean, downloadLink: string, isbn13: string, nid: string, fileType: string }[] = [];
        const mainServiceUrl = this.config.mainServiceUrl;
        for (let refreshLink of $("dd.productState a", ebookListElement)) {
            let refreshData: { ready: boolean, downloadLink: string, isbn13: string, nid: string, fileType: string };
            if (refreshLink.attribs["href"].indexOf("javascript:regen") >= 0) {
                const regenParameters = this.parseRegenCallParameters(refreshLink.attribs["href"]);
                refreshData = {
                    ready: false,
                    downloadLink: null,
                    isbn13: regenParameters.isbn,
                    nid: regenParameters.nid,
                    fileType: regenParameters.fileType
                };
            } else {
                refreshData = {
                    ready: true,
                    downloadLink: `${this.config.mainServiceUrl}${refreshLink.attribs["href"]}`.replace(/([^:])[\/]+/g, "$1/"),
                    isbn13: null,
                    nid: null,
                    fileType: refreshLink.attribs["href"].match(/\/[a-z]+\.aspx/)[0].replace(/\/|\.aspx/g, '')
                };
            }
            if (result.indexOf(refreshData) < 0) {
                result.push(refreshData);
            }
        }
        return result;
    }

    private parseRegenCallParameters(regenCall: string) {
        const ISBN: number = 1;
        const NID: number = 2;
        const FILE_TYPE = 4;
        let bookElementData = regenCall
            .replace(/javascript:regen\(|\)|'|"/g, '')
            .split(',');
        return {
            isbn: bookElementData[ISBN].trim(),
            nid: bookElementData[NID].trim(),
            fileType: bookElementData[FILE_TYPE].trim()
        }
    }

    private async generateProduct(request: any, isbn: string, nid: string, fileType: string): Promise<{ ready: boolean; error: string }> {
        const postRequestOptions = {
            headers: {
                origin: this.config.mainPageUrl,
                referer: this.config.bookshelfUrl,
                'DNT': 1,
                'X-Requested-With': 'XMLHttpRequest'
            },
            form: {
                isbn13: isbn,
                nid: nid,
                format: fileType
            }
        };
        console.log(`${new Date().toISOString()} - Started generating ${fileType} file`);
        const xmlParser = new xml2js.Parser();
        let postResult = await request.post(this.config.generateProductServiceUrl, postRequestOptions);
        const postResponse = await xmlParser.parseStringPromise(postResult);
        if (postResponse.Result.RequestSuccess[0] == "True") {
            return await this.waitUntilGenerated(request, postRequestOptions, xmlParser);
        } else {
            console.log(`${new Date().toISOString()} - Cannot generate ${fileType} file`);
            return ({ready: false, error: `Cannot generate ${fileType} file`});
        }
    }

    private async waitUntilGenerated(request: any, postRequestOptions: { form: { isbn13: string; nid: string; format: string } }, xmlParser: xml2js.Parser) {
        const MAX_RETRY = 60;
        let counter: number = 0;
        let delay: number = 0;
        let response;
        do {
            await timingUtils.delayExactly(delay);
            const responseXml = await request.post(this.config.generateProductServiceUrl, postRequestOptions);
            response = await xmlParser.parseStringPromise(responseXml);
            console.log(`${new Date().toISOString()} - Waiting for ${postRequestOptions.form.format} file to be generated: attempt ${counter} - RequestSuccess ${response.Result.RequestSuccess[0]}, GenerationCompleted ${response.Result.GenerationCompleted[0]}`);
            delay = ONE_SECOND * 5;
            counter++;
        } while (response.Result.GenerationCompleted[0] == "False" && counter < MAX_RETRY);
        if (counter <= MAX_RETRY && response.Result.GenerationCompleted[0] == "True") {
            return ({ready: true, error: null});
        } else {
            return ({
                ready: false,
                error: `Gave up generating ${postRequestOptions.form.format} file after ${MAX_RETRY} requests`
            });
        }
    }

    private async checkSizeAndDownloadBook(request: any, downloadLink, title: string, fileFormat: string) {
        const bookName: string = stringUtils.formatPathName(`${title}`);
        const downloadDir = `${this.booksDir}/${bookName}`;
        if (!(await filesystemUtils.checkIfDirectoryExists(downloadDir))) {
            FS.mkdirSync(downloadDir);
        }
        const fileName = `${bookName}.${fileFormat}`;
        if (!(await filesystemUtils.checkIfElementExists(downloadDir, fileName))) {
            return this.checkSizeAndDownloadFile(request, downloadLink, ONE_SECOND * 3, downloadDir, fileName);
        } else {
            console.log(`${new Date().toISOString()} - No need to download ${fileFormat} file for ${bookName} - already downloaded`);
        }
    }
}
