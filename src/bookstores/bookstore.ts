'use strict';

import {FileCookieStore} from "tough-cookie-file-store";
import {CookieJar} from "tough-cookie"
import * as FS from "fs";
import {createWriteStream} from "fs";
import {timingUtils} from "../utils/timingUtils";
import got from 'got'

import * as constants from "../../config/config.json";

export abstract class Bookstore {
    protected notLoggedInRedirectUrlPart: string;

    protected config;
    protected cookiesDir: string;
    protected booksDir: string;
    protected maxFileSize: number;

    constructor(bookshopConfig: any, cookiesDir: string, booksDir: string, maxFileSize: number) {
        this.config = bookshopConfig;
        this.cookiesDir = cookiesDir;
        this.booksDir = booksDir;
        this.maxFileSize = maxFileSize;
        console.log(`${new Date().toISOString()} - ${this.config.bookstoreName} bookstore class instantiated for ${this.config.login}`);
    }

    protected prepareRequestDefaults() {
        const cookiePath = `${this.cookiesDir}${this.config.login.replace('@', '-')}.${this.config.moduleName}.cookies.json`;

        if (!FS.existsSync(cookiePath)) {
            FS.closeSync(FS.openSync(cookiePath, 'w'));
        }
        let fileCookieStore = new FileCookieStore(cookiePath);
        let cookieJar = new CookieJar(fileCookieStore);
        return got.extend({
            headers: {
                'User-Agent': constants.userAgent
            }
        }).extend({cookieJar});
    }

    async getBooks() {
        const request = this.prepareRequestDefaults();
        let {isLoggedIn: isLoggedIn, body: pageBody} = await this.checkIfUserIsLoggedIn(request);
        if (isLoggedIn) {
            console.log(`${new Date().toISOString()} - User ${this.config.login} is logged in`);
        } else {
            console.log(`${new Date().toISOString()} - User ${this.config.login} not logged in`);
            pageBody = await this.logIn(request);
        }
        await this.getProducts(request, pageBody);
    }

    protected abstract logIn(request: any): Promise<string>;

    protected abstract getProducts(request: any, bookshelfPageBody: string);

    protected async getPageBody(request: any, pageUrl: string, delay: number, exactDelay: boolean = false): Promise<string> {
        if (exactDelay) {
            await timingUtils.delayExactly(delay);
        } else {
            await timingUtils.delay(delay);
        }
        return new Promise((resolve, reject) => {
            request.get(pageUrl)
                .then((response) => {
                    resolve(response.body);
                })
                .catch((error) => {
                    console.log(`${new Date().toISOString()} - An error occured while fetching  ${pageUrl}: ${error}`);
                    reject(error);
                });
        });
    }

    protected async getPageBodyWithAdditionalOptions(request: any, pageUrl: string, delay: number, exactDelay, additionalOptions: any): Promise<string> {
        if (exactDelay) {
            await timingUtils.delayExactly(delay);
        } else {
            await timingUtils.delay(delay);
        }
        // console.log(pageUrl);
        return new Promise((resolve, reject) => {
            request.get(pageUrl, additionalOptions)
                .then((response) => {
                    resolve(response.body);
                })
                .catch((error) => {
                    console.log(`${new Date().toISOString()} - An error occured while fetching  ${pageUrl}: ${error}`);
                    reject(error);
                });
        });
    }

    protected async getFullPageResponse(request: any, pageUrl: string, delay: number): Promise<string> {
        await timingUtils.delay(delay);
        return new Promise((resolve, reject) => {
            request.get(pageUrl)
                .then((response) => {
                    resolve(response);
                })
                .catch((error) => {
                    console.log(`${new Date().toISOString()} - An error occured while fetching  ${pageUrl}: ${error}`);
                    reject(error);
                });
        });
    }

    protected async checkIfUserIsLoggedIn(request: any): Promise<{ isLoggedIn: boolean, body: string }> {
        const getRequestOptions = {
            resolveWithFullResponse: true
        };
        return new Promise((resolve, reject) => {
            request.get(this.config.bookshelfUrl, getRequestOptions)
                .then((response) => {
                    resolve({
                        isLoggedIn: (response.url.indexOf(this.notLoggedInRedirectUrlPart) < 0),
                        body: response.body
                    });
                })
                .catch((error) => {
                    reject(`Could not check if ${this.config.login} is logged in. Error: ${error}`)
                });
        });
    }

    protected async visitLoginForm(request: any, loginFormUrl: string): Promise<string> {
        const pageBody = this.getPageBody(request, loginFormUrl, 0);
        await timingUtils.delayExactly(timingUtils.ONE_SECOND * 3);
        return pageBody;
    }

    protected sendLoginForm(request: any, postRequestOptions: object): Promise<string> {
        return new Promise((resolve, reject) => {
            request.post(this.config.loginServiceUrl, postRequestOptions)
                .then((response) => {
                    this.checkIfUserIsLoggedIn(request)
                        .then((checkResult) => {
                            if (checkResult.isLoggedIn) {
                                console.log(`${new Date().toISOString()} - Logged in as ${this.config.login}`);
                                resolve(checkResult.body);
                            } else {
                                reject(`Could not log in as ${this.config.login}`);
                            }
                        }).catch((error) => {
                        reject(`Could not check if ${this.config.login} is logged in. Error: ${error}`);
                    });
                })
                .catch((error) => {
                    reject(`Could not log in as ${this.config.login}. Error: ${error}`);
                })
        });
    }

    protected async downloadFile(request: any, downloadUrl: string, delay: number, downloadDir: string, fileName: string, doUriEncoding: boolean = true): Promise<any> {
        return new Promise((resolve, reject) => {
            console.log(`${new Date().toISOString()} - Started downloading ${fileName}`);
            const fileUrl = doUriEncoding ? encodeURI(downloadUrl) : downloadUrl;
            const downloadStream = request.stream(downloadUrl, {followRedirect: true});
            const fileWriterStream = createWriteStream(`${downloadDir}/${fileName}`);
            let lastPercentage = 0;
            downloadStream
                .on("downloadProgress", ({ transferred, total, percent }) => {
                    const percentage = Math.round(percent * 100);
                    if(percentage != lastPercentage) {
                        lastPercentage = percentage;
                        console.log(`${new Date().toISOString()} - Progress downloading "${fileName}": ${transferred}/${total} (${percentage}%)`);
                    }
                })
                .on("error", (error) => {
                    reject(`Error getting ${fileUrl}: ${error.message}`);
                });

            fileWriterStream
                .on("error", (error) => {
                    reject(`Could not write ${fileUrl} to system: ${error.message}`);
                })
                .on("finish", () => {
                    console.log(`${new Date().toISOString()} - Finished downloading ${fileName}`);
                    resolve(true);
                });

            downloadStream.pipe(fileWriterStream);
        });
    }
}
