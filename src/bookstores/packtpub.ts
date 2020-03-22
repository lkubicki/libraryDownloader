'use strict';

import * as FS from "fs";
import {Bookstore} from "./bookstore";
import {filesystemUtils} from "../utils/filesystemUtils";
import {timingUtils} from "../utils/timingUtils";
import {stringUtils} from "../utils/stringUtils";

const DELAY: number = 1000;

const FILE_EXTENSIONS = {
    code: "code.zip",
    epub: "epub",
    mobi: "mobi",
    pdf: "pdf",
    video: "zip"
};

export class PacktPub extends Bookstore {
    protected async checkIfUserIsLoggedIn(request: any): Promise<{ isLoggedIn: boolean, body: string }> {
        return new Promise((resolve) => {
            resolve({isLoggedIn: false, body: null});
        })
    }

    protected async getProducts(request: any, loginResultPageBody: Object) {
        let accessToken: Object = loginResultPageBody['data'].access;
        let refreshToken: Object = loginResultPageBody['data'].refresh;

        console.log(`${new Date().toISOString()} - Got access token`);

        var offset: number = 0;
        var numberOfBooks: number = 0;
        do {
            await timingUtils.delay(DELAY);
            const bookshelfContents: Object = await this.getBookshelfContents(request, this.config.bookshelfServiceUrl, accessToken, offset);
            numberOfBooks = bookshelfContents['count'];
            const listOfBooks = bookshelfContents['data'];
            offset += 25;
            for (let bookMetadata of listOfBooks) {
                try {
                    const tokens: { refresh: Object, access: Object } = await this.getNewTokens(request, refreshToken, accessToken);
                    refreshToken = tokens.refresh;
                    accessToken = tokens.access;
                    const bookDownloadableItems = await this.getBookDetails(request, this.config.typesServiceUrl, accessToken, bookMetadata['productId']);
                    for (const downloadableItemType of bookDownloadableItems['fileTypes']) {
                        await this.downloadBookshelfItem(request, accessToken, bookMetadata, downloadableItemType);
                    }
                } catch (error) {
                    console.log(`${new Date().toISOString()} - Error downloading ${bookMetadata['productName']} - ${error}`);
                }
            }
        } while (offset < numberOfBooks);
    }

    private async downloadBookshelfItem(request, accessToken: Object, bookMetadata, downloadableItemType: any) {
        const bookTitle = stringUtils.formatPathName(bookMetadata['productName']).trim();
        const downloadDirectory: string = (`${this.booksDir}/${bookTitle}`);
        const fileName: string = stringUtils.formatPathName(`${bookTitle}.${FILE_EXTENSIONS[downloadableItemType]}`);
        const downloadDirectoryExists: boolean = await filesystemUtils.checkIfDirectoryExists(downloadDirectory);
        var elementExists: boolean = false;
        if (downloadDirectoryExists) {
            elementExists = await filesystemUtils.checkIfElementExists(downloadDirectory, fileName)
        } else {
            FS.mkdirSync(downloadDirectory);
        }
        if (!elementExists) {
            await timingUtils.delay(DELAY);
            const bookDownloadableUrl: string = await this.getDownloadUrl(request, this.config.productDownloadServiceUrl, accessToken, bookMetadata['productId'], downloadableItemType);
            await this.downloadBookshelfItemFile(request, bookDownloadableUrl, accessToken, downloadDirectory, fileName);
        } else {
            console.log(`${new Date().toISOString()} - ${fileName} already downloaded`);
        }
    }

    private async downloadBookshelfItemFile(request, bookDownloadableUrl: string, accessToken: Object, downloadDirectory: string, fileName: string) {
        console.log(`${new Date().toISOString()} - Checking size of ${fileName}`);
        var elementSize = await this.getElementSize(request, bookDownloadableUrl, accessToken);
        if (elementSize.fileSize <= this.maxFileSize) {
            await this.downloadElement(request, bookDownloadableUrl, accessToken, downloadDirectory, fileName);
        } else {
            console.log(`${new Date().toISOString()} - Could not download ${fileName} as it has size of ${elementSize.fileSize} which is more than allowed ${this.maxFileSize}. Download link: ${bookDownloadableUrl}`);
        }
    }

    protected async logIn(request): Promise<string> {
        return new Promise((resolve, reject) => {
            const optionsRequestOptions = {
                resolveWithFullResponse: true,
                method: 'OPTIONS'
            };
            const postRequestOptions = {
                headers: {
                    'Content-Type': 'application/json'
                },
                resolveWithFullResponse: true,
                json: {
                    username: this.config.login,
                    password: this.config.password
                }
            };
            request(this.config.loginServiceUrl, optionsRequestOptions)
                .then((response) => {
                    request.post(this.config.loginServiceUrl, postRequestOptions)
                        .then((response) => {
                            if (response.statusCode === 200) {
                                console.log(`${new Date().toISOString()} - Logged in user ${this.config.login} in ${this.config.bookstoreName} bookstore`);
                                resolve(response.body);
                            } else {
                                reject(`Got response code ${response.statusCode} while getting access token`);
                            }
                        })
                })
                .catch((error) => {
                    reject(`Could not log in as ${this.config.login}. Error: ${error}`);
                })
        });
    }

    private async getNewTokens(request: any, refreshToken: Object, accessToken: Object): Promise<{ refresh: Object, access: Object }> {
        return new Promise((resolve, reject) => {
            const postRequestOptions = {
                headers: {
                    'Content-Type': 'application/json'
                },
                resolveWithFullResponse: true,
                json: {
                    refresh: refreshToken
                },
                auth: {
                    bearer: accessToken
                }
            };
            request.post(this.config.tokensServiceUrl, postRequestOptions)
                .then((response) => {
                    if (response.statusCode === 200) {
                        resolve({refresh: response.body.data.refresh, access: response.body.data.access});
                    } else {
                        reject(`Got response code ${response.statusCode} while getting access token`);
                    }
                })
        });
    }

    private async getBookshelfContents(request: any, bookshelfServiceUrl: string, accessToken: Object, offset: number): Promise<Object> {
        console.log(`${new Date().toISOString()} - Getting list of books starting from offset ${offset}`);
        const bookshelfServiceUrlWithOffset = bookshelfServiceUrl.replace('{offset}', offset.toString());
        return new Promise((resolve, reject) => {
            const optionsRequestOptions = {
                resolveWithFullResponse: true, method: 'OPTIONS'
            };
            const getRequestOptions = {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Connection': 'keep-alive'
                },
                auth: {
                    bearer: accessToken
                }
            };
            request(bookshelfServiceUrlWithOffset, optionsRequestOptions)
                .then((response) => {
                    request.get(bookshelfServiceUrlWithOffset, getRequestOptions)
                        .then((response) => {
                            resolve(JSON.parse(response));
                        })
                })
        });
    }

    private async getBookDetails(request: any, typesServiceUrl: string, accessToken: Object, isbn: string): Promise<Object> {
        const typesServiceWithIsbn = typesServiceUrl.replace('{isbn}', isbn);
        return new Promise((resolve, reject) => {
            const optionsRequestOptions = {
                resolveWithFullResponse: true, method: 'OPTIONS'
            };
            const getRequestOptions = {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Connection': 'keep-alive'
                },
                auth: {
                    bearer: accessToken
                }
            };
            request(typesServiceWithIsbn, optionsRequestOptions)
                .then((response) => {
                    request.get(typesServiceWithIsbn, getRequestOptions)
                        .then((response) => {
                            resolve(JSON.parse(response)['data'][0]);
                        })
                        .catch((error) => {
                            reject(error)
                        });
                });
        });
    }

    private async getDownloadUrl(request: any, productDownloadServiceUrl: any, accessToken: Object, isbn: string, fileType: string): Promise<string> {
        const downloadServiceUrl = productDownloadServiceUrl.replace('{isbn}', isbn).replace('{type}', fileType);
        return new Promise((resolve, reject) => {
            const optionsRequestOptions = {
                resolveWithFullResponse: true, method: 'OPTIONS'
            };
            const getRequestOptions = {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Connection': 'keep-alive'
                },
                auth: {
                    bearer: accessToken
                }
            };
            request(downloadServiceUrl, optionsRequestOptions)
                .then((response) => {
                    request.get(downloadServiceUrl, getRequestOptions)
                        .then((response) => {
                            resolve(JSON.parse(response)['data']);
                        })
                        .catch(error => reject(error));
                })
        });
    }

    private async getElementSize(request: any,
                                 downloadUrl: string,
                                 accessToken: Object): Promise<{ fileSize: number }> {
        return new Promise((resolve, reject) => {
            const getRequestOptions = {
                resolveWithFullResponse: true,
                headers: {
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Referer': 'https://account.packtpub.com/account/products',
                    'Origin': 'https://account.packtpub.com',
                    'TE': 'Trailers',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'Connection': 'keep-alive'
                },
                auth: {
                    bearer: accessToken
                }
            };
            request.head(downloadUrl, getRequestOptions)
                .then((response) => {
                    resolve({fileSize: response.headers['content-length']});
                })
        });
    }

    private async downloadElement(request: any,
                                  downloadUrl: string,
                                  accessToken: Object,
                                  bookDir: string,
                                  fileName: string) {
        console.log(`${new Date().toISOString()} - Downloading ${fileName}`);

        return new Promise((resolve, reject) => {
            const getRequestOptions = {
                headers: {
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Referer': 'https://account.packtpub.com/account/products',
                    'Origin': 'https://account.packtpub.com',
                    'TE': 'Trailers',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'Connection': 'keep-alive',
                    'Method': 'GET'
                },
                auth: {
                    bearer: accessToken
                }
            };
            let stream = request(downloadUrl, getRequestOptions)
                .pipe(FS.createWriteStream(`${bookDir}/${fileName}`))
                .on('finish', () => {
                    console.log(`${new Date().toISOString()} - ${fileName} downloaded`);
                    resolve();
                })
                .on('error', (error) => {
                    reject(error);
                });
        });
    }
}