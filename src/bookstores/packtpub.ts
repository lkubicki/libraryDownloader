'use strict';

import * as FS from "fs";
import {Bookstore} from "./bookstore";
import {filesystemUtils} from "../utils/filesystemUtils";
import {timingUtils} from "../utils/timingUtils";
import {stringUtils} from "../utils/stringUtils";
import {createWriteStream} from "fs";

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
            await timingUtils.delay(timingUtils.ONE_SECOND);
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
            await timingUtils.delay(timingUtils.ONE_SECOND);
            const bookDownloadableUrl: string = await this.getDownloadUrl(request, this.config.productDownloadServiceUrl, accessToken, bookMetadata['productId'], downloadableItemType);
            await this.downloadElement(request, bookDownloadableUrl, accessToken, downloadDirectory, fileName)
                .catch((error) => console.log(`${new Date().toISOString()} - ${error}`));
        } else {
            console.log(`${new Date().toISOString()} - ${fileName} already downloaded`);
        }
    }

    protected async logIn(request): Promise<string> {
        return new Promise((resolve, reject) => {
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
            request.post(this.config.loginServiceUrl, postRequestOptions)
                .then((response) => {
                    if (response.statusCode === 200) {
                        console.log(`${new Date().toISOString()} - Logged in user ${this.config.login} in ${this.config.bookstoreName} bookstore`);
                        resolve(JSON.parse(response.body));
                    } else {
                        reject(`Got response code ${response.statusCode} while getting access token`);
                    }
                }).catch((error) => {
                reject(`Could not log in as ${this.config.login}. Error: ${error}`);
            })
        });
    }

    private async getNewTokens(request: any, refreshToken: Object, accessToken: Object): Promise<{ refresh: Object, access: Object }> {
        return new Promise((resolve, reject) => {
            const postRequestOptions = {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                },
                resolveWithFullResponse: true,
                json: {
                    refresh: refreshToken
                }
            };
            request.post(this.config.tokensServiceUrl, postRequestOptions)
                .then((response) => {
                    if (response.statusCode === 200) {
                        const responseData = JSON.parse(response.body)
                        resolve({refresh: responseData.data.refresh, access: responseData.data.access});
                    } else {
                        reject(`Got response code ${response.statusCode} while getting access token`);
                    }
                })
                .catch((error) => reject(`Got error while getting access token: ${error}`))
        });
    }

    private async getBookshelfContents(request: any, bookshelfServiceUrl: string, accessToken: Object, offset: number): Promise<Object> {
        console.log(`${new Date().toISOString()} - Getting list of books starting from offset ${offset}`);
        const bookshelfServiceUrlWithOffset = bookshelfServiceUrl.replace('{offset}', offset.toString());
        return new Promise((resolve, reject) => {
            const getRequestOptions = {
                headers: {
                    // 'Content-Type': 'application/json',
                    'Accept': '*.*',
                    'Connection': 'keep-alive',
                    'Authorization': `Bearer ${accessToken}`
                }
            };
            if (bookshelfServiceUrlWithOffset !== undefined || !bookshelfServiceUrlWithOffset.startsWith("http")) {
                request.get(bookshelfServiceUrlWithOffset, getRequestOptions)
                    .then((response) => {
                        resolve(JSON.parse(response.body));
                    })
                    .catch((error) =>
                        reject(`Could not retrieve bookshelf page ${bookshelfServiceUrlWithOffset} contents: ${error}`)
                    )
            } else {
                reject(`Incorrect bookshelf URL: ${bookshelfServiceUrlWithOffset}`)
            }
        });
    }

    private async getBookDetails(request: any, typesServiceUrl: string, accessToken: Object, isbn: string): Promise<Object> {
        const typesServiceWithIsbn = typesServiceUrl.replace('{isbn}', isbn);
        return new Promise((resolve, reject) => {
            const optionsRequestOptions = {
                resolveWithFullResponse: true,
                method: 'OPTIONS'
            };
            const getRequestOptions = {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Connection': 'keep-alive',
                    'Authorization': `Bearer ${accessToken}`
                }
            };
            request(typesServiceWithIsbn, optionsRequestOptions)
                .then((response) => {
                    request.get(typesServiceWithIsbn, getRequestOptions)
                        .then((response) => {
                            resolve(JSON.parse(response.body)['data'][0]);
                        })
                        .catch((error) => {
                            reject(`Could not get filetypes for ${isbn}: ${error}`)
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
                    'Connection': 'keep-alive',
                    'Authorization': `Bearer ${accessToken}`
                }
            };
            request(downloadServiceUrl, optionsRequestOptions)
                .then((response) => {
                    request.get(downloadServiceUrl, getRequestOptions)
                        .then((response) => {
                            resolve(JSON.parse(response.body)['data']);
                        })
                        .catch(error => reject(`Could not get download url for ${fileType} file for ${isbn}: ${error}`));
                })
        });
    }

    private async downloadElement(request: any,
                                  downloadUrl: string,
                                  accessToken: Object,
                                  downloadDir: string,
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
                    'Method': 'GET',
                    'Authorization': `Bearer ${accessToken}`
                }
            };
            const downloadStream = request.stream(downloadUrl, {followRedirect: true});
            const fileWriterStream = createWriteStream(`${downloadDir}/${fileName}`);
            downloadStream
                .on("error", (error) => {
                    reject(`Error getting ${downloadUrl}: ${error.message}`);
                });

            fileWriterStream
                .on("error", (error) => {
                    reject(`Could not write ${downloadUrl} to system: ${error.message}`);
                })
                .on("finish", () => {
                    console.log(`${new Date().toISOString()} - Finished downloading ${fileName}`);
                    resolve(true);
                });

            downloadStream.pipe(fileWriterStream);
        });
    }
}