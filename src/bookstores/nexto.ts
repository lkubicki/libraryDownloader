'use strict';

import * as cheerio from "cheerio";
import * as FS from "fs";
import * as xml2js from "xml2js"
import {Bookstore} from "./bookstore";
import {filesystemUtils} from "../utils/filesystemUtils";
import {timingUtils} from "../utils/timingUtils";
import {stringUtils} from "../utils/stringUtils";

export class Nexto extends Bookstore {
    protected notLoggedInRedirectUrlPart = "login.xml";

    protected async logIn(request: any): Promise<string> {
        await this.visitLoginForm(request, this.config.loginFormUrl);
        console.log(`${new Date().toISOString()} - Logging in as ${this.config.login}`);

        const loginRequestOptions = {
            resolveWithFullResponse: true,
            form: {
                fb_form_id: 'login',
                email: this.config.login,
                password: this.config.password,
                extra_param: null,
                remember: {
                    0: 1,
                    1: 0
                }
            }
        };

        return this.sendLoginForm(request, loginRequestOptions);
    }

    protected async getProducts(request: any, bookshelfPageBody: string) {
        let $ = await cheerio.load(bookshelfPageBody);
        const pageUrls: string[] = this.getPageUrls($, bookshelfPageBody);
        await this.downloadProductsFromPage(request, bookshelfPageBody);
        for (let shelfPageUrl of pageUrls) {
            const pageBody = await this.getPageBody(request, shelfPageUrl, timingUtils.ONE_SECOND);
            await this.downloadProductsFromPage(request, pageBody);
        }
    }

    private async downloadProductsFromPage(request: any, bookshelfPageBody) {
        let $ = await cheerio.load(bookshelfPageBody);
        for (let productPart of $('#library tbody tr')) {
            const title: string = this.getTitle($, productPart);
            const authors: string = this.getAuthors($, productPart);
            const downloadData: { fileType: string, downloadLink: string }[] = this.getDownloadData($, $('.download_td a.link-download-a', productPart));
            const bookName = `${title} - ${authors}`;
            for (let download of downloadData) {
                const fileName = stringUtils.formatPathName(`${title} - ${authors}`);
                const downloadDir = `${this.booksDir}${fileName}`;
                if (!(await filesystemUtils.checkIfElementExists(downloadDir, `${fileName}.${download.fileType}`))) {
                    try {
                        let productUrlParams: { fileId: string, fileTypeId: string } = this.getProductDownloadParameters(download.downloadLink);
                        let productStatus = await this.getProductStatus(request, productUrlParams.fileId, productUrlParams.fileTypeId);
                        let generationResult;
                        switch (productStatus) {
                            case '1':
                                console.log(`${new Date().toISOString()} - Preparing ${download.fileType} file for ${bookName}`);
                                await this.prepareProduct(request, productUrlParams.fileId, productUrlParams.fileTypeId);
                                generationResult = await this.waitForProductToBeGenerated(request, productUrlParams.fileId, productUrlParams.fileTypeId)
                                if (generationResult.ready) {
                                    await this.downloadProduct(request, bookName, download.fileType, download.downloadLink);
                                } else {
                                    console.log(`${new Date().toISOString()} - Error generating ${download.fileType} file for ${title} by ${authors} - ${generationResult.error}`);
                                }
                                break;
                            case '2':
                                generationResult = await this.waitForProductToBeGenerated(request, productUrlParams.fileId, productUrlParams.fileTypeId)
                                if (generationResult.ready) {
                                    await this.downloadProduct(request, bookName, download.fileType, download.downloadLink);
                                } else {
                                    console.log(`${new Date().toISOString()} - Error generating ${download.fileType} file for ${title} by ${authors} - ${generationResult.error}`);
                                }
                                break;
                            case '3':
                                await this.downloadProduct(request, bookName, download.fileType, download.downloadLink);
                                break;
                            default:
                                console.log(`${new Date().toISOString()} - Unrecognized status: ${productStatus}`);
                                break;
                        }
                    } catch (error) {
                        console.log(`${new Date().toISOString()} - Error downloading ${download.fileType} file for ${title} by ${authors} - ${error}`);
                    }
                } else {
                    console.log(`${new Date().toISOString()} - No need to download ${download.fileType} file for ${bookName} - already downloaded`);
                }
            }
        }
    }

    private getAuthors($: any, productPart: any) {
        return $('.title div b a', productPart).text()
            .replace(/,[\s]*$/g, '')
            .substring(0, 100)
            .trim();
    }

    private getTitle($: any, productPart: any) {
        return $('.title span', productPart).text()
            .replace(/[\s]+/g, ' ')
            .replace(/[\s]+-[\s]+e[-]*book|[\s]+-[\s]+audiobook/g, '')
            .trim();
    }

    private getDownloadData($: any, downloadButtons: any): { fileType: string, downloadLink: string }[] {
        let result: { fileType: string, downloadLink: string }[] = [];
        for (let downloadButton of downloadButtons) {
            const fileType: string = this.getFileType(downloadButton);
            const downloadLink = downloadButton.attribs['href'].replace(/\s+/g, ' ').trim();
            const downloadData: { fileType: string, downloadLink: string } = {
                fileType: fileType,
                downloadLink: downloadLink
            };
            if (result.indexOf(downloadData) < 0) {
                result.push(downloadData);
            }
        }
        return result;
    }

    private getFileType(downloadButton: any) {
        const fileType = downloadButton.children[0].data.match(/^[a-zA-Z0-9]+/, '')[0].trim();
        if (fileType.toLowerCase() == 'mp3') {
            return 'zip';
        }
        return fileType;
    }

    private async downloadProduct(request: any, bookName: string, fileExtension: string, downloadLink: string) {
        const bookNameAsPath: string = stringUtils.formatPathName(bookName);
        const downloadDir: string = `${this.booksDir}/${bookNameAsPath}`;
        const bookFileName: string = `${bookNameAsPath}.${fileExtension}`;
        const downloadUrl: string = `${this.config.mainPageUrl}/${downloadLink}`.replace(/([^:])[\/]+/g, "$1/");

        if (!(await filesystemUtils.checkIfDirectoryExists(downloadDir))) {
            FS.mkdirSync(downloadDir);
        }
        if (!(await filesystemUtils.checkIfElementExists(downloadDir, bookFileName))) {
            return this.downloadFile(request, downloadUrl, timingUtils.ONE_SECOND *3, downloadDir, bookFileName);
        } else {
            console.log(`${new Date().toISOString()} - No need to download ${fileExtension} file for ${bookName} - already downloaded`);
        }
    }

    private getPageUrls($: any, bookshelfPageBody: string): string[] {
        let result: string[] = [];
        for (let pageLink of $('.listnavigator a:not([class])')) {
            const downloadLink = `${this.config.mainPageUrl}${pageLink.attribs['href']}`.replace(/\s+/g, ' ').trim();
            if (result.indexOf(downloadLink) < 0) {
                result.push(downloadLink);
            }
        }
        return result;
    }

    private getProductDownloadParameters(downloadLink: string): { fileId: string, fileTypeId: string } {
        const FILE_ID = 0;
        const FILE_TYPE = 2;
        const params = downloadLink.replace(/[.]+\?/, '').split('&');
        return {fileId: params[FILE_ID].split('=')[1], fileTypeId: params[FILE_TYPE].split('=')[1]};
    }

    private async getProductStatus(request: any, fileId: string, fileTypeId: string): Promise<string> {
        return this.callService(request, this.config.productStatusServiceUrl, fileId, fileTypeId);
    }

    private async prepareProduct(request: any, fileId: string, fileTypeId: string) {
        return this.callService(request, this.config.prepareProductServiceUrl, fileId, fileTypeId);
    }

    private async waitForProductToBeGenerated(request: any, fileId: string, fileTypeId: string) {
        const MAX_RETRY = 60;
        let delay: number = 0;
        let productStatus: string;
        let count: number = 0;
        do {
            console.log(`${new Date().toISOString()} - Checking if download is ready`);
            await timingUtils.delayExactly(delay);
            productStatus = await this.getProductStatus(request, fileId, fileTypeId);
            delay = timingUtils.ONE_SECOND * 5;
            count++
        } while (productStatus != '3' && count < MAX_RETRY);
        if (productStatus == '3') {
            return {ready: true, error: null}
        } else {
            return {ready: false, error: `Could not generate file after ${count} attempts`}
        }
    }

    private async callService(request: any, serviceUrlTemplate: string, fileId: string, fileTypeId: string): Promise<string> {
        const statusServiceUrl = this.prepareServiceUrl(serviceUrlTemplate, fileId, fileTypeId);
        const productStatusResponse = await this.getPageBody(request, statusServiceUrl, timingUtils.ONE_SECOND, false);
        const xmlParser = new xml2js.Parser();
        const productStatus = await xmlParser.parseStringPromise(productStatusResponse);
        return productStatus.result.int[0].replace('.0', '');
    }

    private prepareServiceUrl(serviceUrlTemplate: string, fileId: string, fileTypeId: string): string {
        const mapObj = {
            _fileId_: fileId,
            _fileTypeId_: fileTypeId
        };
        return serviceUrlTemplate.replace(/_fileId_|_fileTypeId_/gi, function (matched) {
            return mapObj[matched];
        });
    }
}
