'use strict';

import * as cheerio from "cheerio";
import * as FS from "fs";
import {Bookstore} from "./bookstore";
import {timingUtils} from "../utils/timingUtils";
import {filesystemUtils} from "../utils/filesystemUtils";
import {stringUtils} from "../utils/stringUtils";

export class Apress extends Bookstore {
    protected notLoggedInRedirectUrlPart: string = "login";

    protected async logIn(request: any): Promise<string> {
        await this.visitLoginForm(request, this.config.loginFormUrl);
        await timingUtils.delay(timingUtils.ONE_SECOND * 3);
        console.log(`${new Date().toISOString()} - Logging in as ${this.config.login}`);

        const loginRequestOptions = {
            resolveWithFullResponse: true,
            method: "POST",
            form: {
                email: this.config.login,
                password: this.config.password,
                url: this.config.bookshelfUrl
            }
        };

        return this.sendLoginForm(request, loginRequestOptions);
    }

    protected async getProducts(request: any, bookshelfPageBody: string) {
        let $ = await cheerio.load(bookshelfPageBody);
        for (let productPart of $('.products ul li .product-information')) {
            const bookTitle = this.getBookTitle($, productPart);
            const bookAuthors = this.getBookAuthors($, productPart);
            console.log(`${new Date().toISOString()} - Getting download url for '${bookTitle}' by ${bookAuthors}`);
            const downloads = await this.getBookDownloads(request, $, productPart);
            for (let download of downloads) {
                console.log(`${new Date().toISOString()} - Getting ${download.fileType} file for '${bookTitle}' by ${bookAuthors}`);
                try {
                    await this.downloadBook(request, `${bookTitle} - ${bookAuthors}`, download);
                } catch (error) {
                    console.log(`${new Date().toISOString()} - Could not download ${download.fileType} file for '${bookTitle}' by ${bookAuthors} - ${error}`);
                }
            }
        }
    }

    private getBookTitle($: any, productPart: any): string {
        let bookTitle = $('h3 a', productPart).text().trim();
        let bookSubtitle = $('.subtitle', productPart).text().trim();
        return `${bookTitle}. ${bookSubtitle}`.replace(/\. $/, '').trim();
    }

    private getBookAuthors($: any, productPart: any): string {
        let authors: string = '';
        for (let author of $('.authors', productPart)) {
            let bookAuthorsData = $(author).text().split(", ");
            if (bookAuthorsData.length >= 2) {
                for (let i = 0; i < bookAuthorsData.length / 2; i++) {
                    authors += `${bookAuthorsData[i * 2 + 1]} ${bookAuthorsData[i * 2]}, `
                }
            }
        }
        return authors.replace(/, $/g, '');
    }

    private async getBookDownloads(request: any, $: any, productPart: any): Promise<{ fileType: string; downloadLink: string }[]> {
        let downloads: { fileType: string; downloadLink: string }[] = [];
        for (let downloadData of $('.bar-download-actions a.download', productPart)) {
            const downloadLinkText = $(downloadData).text();
            let fileType: string = (downloadLinkText != undefined ? downloadLinkText.replace('Download', '').trim() : "");
            const downloadUrl = await this.getPageBody(request, `${this.config.mainPageUrl}${downloadData.attribs['href']}`, timingUtils.ONE_SECOND);
            downloads.push({fileType: fileType, downloadLink: downloadUrl});
        }
        return downloads;
    }

    private async downloadBook(request: any, bookName: string, download: { fileType: string; downloadLink: string }) {
        const bookNameAsPath: string = stringUtils.formatPathName(bookName);
        const downloadDir: string = `${this.booksDir}/${bookNameAsPath}`;
        const bookFileName: string = `${bookNameAsPath}.${download.fileType}`;

        if (!(await filesystemUtils.checkIfDirectoryExists(downloadDir))) {
            FS.mkdirSync(downloadDir);
        }
        if (!(await filesystemUtils.checkIfElementExists(downloadDir, bookFileName))) {
            await this.checkSizeAndDownloadFile(request, download.downloadLink, timingUtils.ONE_SECOND * 3, downloadDir, bookFileName);
        } else {
            console.log(`${new Date().toISOString()} - No need to download ${download.fileType} file for ${bookName} - file already downloaded`);
        }
    }
}
