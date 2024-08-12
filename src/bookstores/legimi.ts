'use strict';

import * as cheerio from "cheerio";
import {Bookstore} from "./bookstore";
import {timingUtils} from "../utils/timingUtils";
import {filesystemUtils} from "../utils/filesystemUtils";
import {stringUtils} from "../utils/stringUtils";
import FS from "fs";

const FILE_TYPES = {
    mp3: {extension: "zip", id: "1"},
    MP3: {extension: "zip", id: "1"},
    epub: {extension: "epub", id: "2"},
    EPUB: {extension: "epub", id: "2"},
    mobi: {extension: "mobi", id: "3"},
    MOBI: {extension: "mobi", id: "3"},
    pdf: {extension: "pdf", id: "4"},
    PDF: {extension: "pdf", id: "4"},
};

export class Legimi extends Bookstore {

    protected notLoggedInRedirectUrlPart = "konto/zaloguj";

    protected async logIn(request: any): Promise<string> {
        let loginFormBody = await this.visitLoginForm(request, this.config.loginFormUrl);
        console.log(`${new Date().toISOString()} - Logging in as ${this.config.login}`);

        let verificationToken = this.findVerificationToken(loginFormBody);
        if (verificationToken) {
            const loginRequestOptions = this.prepareLoginFormData(verificationToken);
            return this.sendLoginForm(request, loginRequestOptions);
        }

    }

    protected async getProducts(request: any, bookshelfPageBody: string) {
        let pageNbr = 1;
        let isThereNextPage = true
        while (isThereNextPage) {
            isThereNextPage = false
            let $ = cheerio.load(bookshelfPageBody);
            for (let productLink of $('.books-on-shelf .book-img-wrap a')) {
                await this.getProduct(request, productLink.attribs['href'])
            }
            if ($('.list-pagination ul.pagination a.icon-arrow-right').attr('aria-label') != undefined) {
                isThereNextPage = true;
                pageNbr++;
                console.log(`${new Date().toISOString()} - Checking page number ${pageNbr}`);
                let bookshelfPageUrl = this.prepareBookshelfUrl(pageNbr);
                bookshelfPageBody = await this.getPageBody(request, bookshelfPageUrl, 2 * timingUtils.ONE_SECOND);
            }
        }
    }

    private findVerificationToken(loginFormBody: string) {
        let $ = cheerio.load(loginFormBody);
        return $("[name~='__RequestVerificationToken']").attr('value')
    }

    private async getProduct(request: any, downloadLinkUrl: string) {
        let downloadPageUrl = this.fixUrlCharacters(`${this.config.mainPageUrl}/${downloadLinkUrl}`);
        await this.getProductFromPage(request, downloadPageUrl)

    }

    private async getProductFromPage(request: any, downloadPageUrl: string) {
        let productPageBody = await this.getPageBody(request, downloadPageUrl, 2 * timingUtils.ONE_SECOND);
        let productData = this.getProductMetadata(productPageBody);
        if (productData != null) {
            console.log(`${new Date().toISOString()} - Fetched metadata for "${productData.title}"`);
            if (productData.fileFormats.length > 0) {
                for (let fileFormat of productData.fileFormats) {
                    let fileFormatId = FILE_TYPES[fileFormat].id;
                    let prepareDownloadUrl = this.preparePrepareDownloadUrl(productData.objectId, fileFormatId);
                    let directDownloadLink = await this.fetchDirectDownloadLink(request, prepareDownloadUrl);
                    await this.downloadProduct(request, directDownloadLink, productData, fileFormat)
                }
            } else {
                console.log(`${new Date().toISOString()} - No downloads available for "${productData.title}"`);
            }
        } else {
            console.log(`${new Date().toISOString()} - Could not fetch metadata from ${downloadPageUrl}`);
        }
    }

    private getProductMetadata(productPageBody: string): {
        objectId: string,
        title: string,
        authors: string,
        fileFormats: string[]
    } {
        let $ = cheerio.load(productPageBody);
        let initScriptString = $('#react-app script').text();
        if (initScriptString != undefined) {
            initScriptString = initScriptString.replace('window["initialReduxState"] = JSON.parse("', '')
                .replace('");', '')
                .replace(/\\u0022/g, '"')
                .replace(/,"analyticsCodes":"{.+}}"}/g, '}')
                .replace(/\\+"/g, '\'')
                .replace(/[<>]+/ig, '')

            const initScript = JSON.parse(initScriptString);
            const bookData = initScript.shelfBookContainer.response.shelfBook;
            if (bookData != null) {
                return {
                    objectId: bookData.synObjId,
                    title: bookData.book.title,
                    authors: bookData.book.authorName,
                    fileFormats: bookData.book.ebook != null && bookData.book.ebook.isBoughtBook ? Object.keys(bookData.book.ebook.bookFormats) : [],
                }
            }
        }
        return null;
    }

    private async fetchDirectDownloadLink(request: any, prepareDownloadUrl: string): Promise<string> {
        let responseString = await this.getPageBody(request, prepareDownloadUrl, 2 * timingUtils.ONE_SECOND)
        let responseObject = JSON.parse(responseString);
        return responseObject.downloadUrl;
    }

    private prepareLoginFormData(verificationToken: string) {
        return {
            contentType: 'application/x-www-form-urlencoded',
            resolveWithFullResponse: true,
            followRedirect: true,
            allowGetBody: true,
            methodRewriting: false,
            form: {
                UserName: this.config.login,
                Password: this.config.password,
                __RequestVerificationToken: verificationToken
            }
        };
    }

    private prepareBookshelfUrl(pageNumber: number) {
        let parameters = new Map([['_PAGE_', pageNumber.toString()]]);

        return this.prepareUrl(this.config.bookshelfPageUrl, parameters);
    }

    private preparePrepareDownloadUrl(objectId: string, fileFormat: string) {
        let parameters = new Map([['_BOOKID_', objectId],
            ["_FORMATID_", fileFormat]]);

        return this.prepareUrl(this.config.prepareDownloadUrl, parameters);
    }

    private async downloadProduct(request: any, directDownloadLink: string, productData: {
        objectId: string;
        title: string;
        authors: string;
        fileFormats: string[]
    }, fileFormat: string) {
        let productTitle: string = stringUtils.formatPathName(`${productData.title}`);
        if (productData.authors != '') {
            productTitle += ` - ${productData.authors}`;
        }
        const downloadDir = `${this.booksDir}/${productTitle}`;
        if (!(await filesystemUtils.checkIfDirectoryExists(downloadDir))) {
            FS.mkdirSync(downloadDir);
        }
        let fileName = `${productTitle}.${FILE_TYPES[fileFormat].extension}`;
        if (!(await filesystemUtils.checkIfElementExists(downloadDir, fileName))) {
            console.log(`${new Date().toISOString()} - Downloading ${fileFormat} file for ${productTitle}`);
            await this.downloadFile(request, directDownloadLink, timingUtils.ONE_SECOND * 2, downloadDir, fileName);
        } else {
            console.log(`${new Date().toISOString()} - No need to download ${fileFormat} file for ${productTitle} - file already exists`);
        }
    }
}