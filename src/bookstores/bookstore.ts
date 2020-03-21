'use strict';

import * as CookieFilestore from 'tough-cookie-filestore';
import * as FS from "fs";
import * as Request from "request-promise";
import {timingUtils} from "../utils/timingUtils";
// require('request-debug')(Request);

const constants = require('../../config/config.json');
const ONE_SECOND: number = 1000;

export abstract class Bookstore {
    protected notLoggedInRedirectUrlPart: string;

    protected config;
    protected cookiesDir: string;
    protected booksDir: string;
    protected maxFileSize: number;

    constructor(bookshopConfig, cookiesDir: string, booksDir: string, maxFileSize: number) {
        this.config = bookshopConfig;
        this.cookiesDir = cookiesDir;
        this.booksDir = booksDir;
        this.maxFileSize = maxFileSize;
        console.log(`${new Date().toISOString()} - ${this.config.bookstoreName} bookstore class instantiated for ${this.config.login}`);
    }

    protected prepareRequestDefaults() {
        var cookiePath = `${this.cookiesDir}${this.config.login.replace('@', '-')}.${this.config.moduleName}.cookies.json`;

        if (!FS.existsSync(cookiePath)) {
            FS.closeSync(FS.openSync(cookiePath, 'w'));
        }
        var cookieJar = Request.jar(new CookieFilestore(cookiePath));
        var request = Request.defaults({
            jar: cookieJar,
            headers: {
                'User-Agent': constants.userAgent
            },
            followAllRedirects: true
        });
        return request;
    }

    async getBooks() {
        const request = this.prepareRequestDefaults();
        let {isLoggedIn: isLoggedIn, body: bookshelfPageBody} = await this.checkIfUserIsLoggedIn(request);
        if (isLoggedIn) {
            console.log(`${new Date().toISOString()} - User ${this.config.login} is logged in`);
        } else {
            console.log(`${new Date().toISOString()} - User ${this.config.login} not logged in`);
            bookshelfPageBody = await this.logIn(request);
        }
        await this.getProducts(request, bookshelfPageBody);
    }

    protected async checkIfUserIsLoggedIn(request: any): Promise<{ isLoggedIn: boolean, body: string }> {
        const getRequestOptions = {
            resolveWithFullResponse: true
        };
        return new Promise((resolve, reject) => {
            request.get(this.config.bookshelfUrl, getRequestOptions)
                .then((response) => {
                    resolve({
                        isLoggedIn: (response.request.uri.href.indexOf(this.notLoggedInRedirectUrlPart) < 0),
                        body: response.body
                    });
                })
                .catch((error) => {
                    console.log(`${new Date().toISOString()} - An error occured: ${error}`);
                    reject(error);
                });
        });
    }

    protected async visitLoginForm(request: any, loginFormUrl: string): Promise<string> {
        const pageBody = this.getPageBody(request, loginFormUrl, 0);
        await timingUtils.delayExactly(ONE_SECOND);
        return pageBody;
    }

    protected abstract async logIn(request: any): Promise<string>;

    protected abstract async getProducts(request: any, bookshelfPageBody: string);

    protected async getPageBody(request: any, pageUrl: string, delay: number, exactDelay: boolean = false): Promise<string> {
        if (exactDelay) {
            await timingUtils.delayExactly(delay);
        } else {
            await timingUtils.delay(delay);
        }
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

    protected async getPageBodyWithAdditionalOptions(request: any, pageUrl: string, delay: number, exactDelay, additionalOptions: any): Promise<string> {
        if (exactDelay) {
            await timingUtils.delayExactly(delay);
        } else {
            await timingUtils.delay(delay);
        }
        return new Promise((resolve, reject) => {
            request.get(pageUrl, additionalOptions)
                .then((response) => {
                    resolve(response);
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

    protected async checkSizeAndDownloadFile(request: any, downloadUrl: string, delay: number, downloadDir: string, fileName: string): Promise<any> {
        return new Promise((resolve, reject) => {
            request.head(encodeURI(downloadUrl)).then((headResponse) => {
                if (headResponse['content-length'] != undefined && headResponse['content-length'] < this.maxFileSize) {
                    return this.downloadFile(request, downloadUrl, delay, downloadDir, fileName);
                } else {
                    console.log(`${new Date().toISOString()} - Could not download ${fileName} as it has size of ${headResponse['content-length']} which is more than allowed ${this.maxFileSize}`);
                    resolve();
                }
            }).catch((error) => {
                reject(`Could not execute HEAD request for ${fileName} from url ${downloadUrl}: ${error}`);
            });
        });
    }

    protected async downloadFile(request: any, downloadUrl: string, delay: number, downloadDir: string, fileName: string): Promise<any> {
        return new Promise((resolve, reject) => {
            console.log(`${new Date().toISOString()} - Downloading ${fileName}`);
            let stream = request.get(encodeURI(downloadUrl))
                .pipe(FS.createWriteStream(`${downloadDir}/${fileName}`))
                .on('finish', () => {
                    console.log(`${new Date().toISOString()} - ${fileName} downloaded`);
                    resolve();
                })
                .on('error', (error) => {
                    reject(`Could not download ${fileName} from url ${downloadUrl}: ${error}`);
                });
        });
    }
}
