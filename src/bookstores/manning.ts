'use strict';

import * as cheerio from "cheerio";
import * as FS from "fs";
import {Bookstore} from "./bookstore";
import {filesystemUtils} from "../utils/filesystemUtils";
import {stringUtils} from "../utils/stringUtils";
import {timingUtils} from "../utils/timingUtils";

export class Manning extends Bookstore {
    protected FILE_EXTENSIONS = {
        KINDLE: 'MOBI',
    };

    protected notLoggedInRedirectUrlPart = "login";

    protected async logIn(request: any): Promise<string> {
        let loginFormBody = await this.visitLoginForm(request, this.config.loginFormUrl);
        let loginFormData: { lt: string, execution: string, eventId: string } = this.getLoginFormData(loginFormBody);
        console.log(`${new Date().toISOString()} - Logging in as ${this.config.login}`);

        const loginRequestOptions = {
            resolveWithFullResponse: true,
            method: "POST",
            form: {
                username: this.config.login,
                password: this.config.password,
                lt: loginFormData.lt,
                execution: loginFormData.execution,
                _eventId: loginFormData.eventId,
                submit: ''
            }
        };

        return this.sendLoginForm(request, loginRequestOptions);
    }

    private getLoginFormData(body: string): { lt: string, execution: string, eventId: string } {
        let $ = cheerio.load(body);
        // const ltValue = $('form input[name="lt"]').val()[0];
        const executionValue = $('form input[name="execution"]').val().toString();
        const eventIdValue = $('form input[name="_eventId"]').val().toString();
        return {lt: undefined, execution: executionValue, eventId: eventIdValue};
    }

    protected async getProducts(request: any, bookshelfPageBody: string) {
        let booksListBody = await this.getPageBody(request, this.config.booksListUrl, 0);
        booksListBody = `<html><body><table>${booksListBody}</table></body></html>`;
        let $ = await cheerio.load(booksListBody);
        for (let productPart of $('tr.license-row')) {
            await timingUtils.delayExactly(timingUtils.ONE_SECOND);
            const title = $('div.product-title', productPart).text().trim();
            const meapLastUpdate = this.getMeapLastUpdate($, productPart);
            const authors = this.formatAuthors($('div.product-authorship', productPart).text());
            const linkElements = $(".dropdown-menu a", productPart);
            for (let linkElement of linkElements) {
                let downloadUrl = linkElement.attribs['href'];
                if (downloadUrl !== undefined && downloadUrl.indexOf('downloadFormat') >= 0) {
                    let downloadFormatTextPosition = downloadUrl.indexOf('downloadFormat');
                    const codeLink = this.getCodeSamplesUrl($, $('.links a[title="download code samples"]', productPart)[0]);
                    const fullDownloadUrl = `${this.config.mainPageUrl}${downloadUrl}`;
                    const fileType = downloadUrl.substring(downloadFormatTextPosition + 15);
                    const fileExtension = this.FILE_EXTENSIONS[fileType] !== undefined ? this.FILE_EXTENSIONS[fileType] : fileType;
                    const bookName = `${title} - ${authors}`;
                    const lastUpdate = `${meapLastUpdate != "" ? " - " + meapLastUpdate : ""}`;
                    await this.downloadProduct(request, bookName, lastUpdate, fileExtension, fullDownloadUrl, codeLink)
                }
            }
        }
    }

    private getMeapLastUpdate($: any, productPart: any): string {
        try {
            const divElement = $('div.meap-last-updated', productPart);
            if (divElement != undefined) {
                return divElement.text()
                    .replace("last update: ", "")
                    .trim();
            }
            return "";
        } catch (error) {
            return "";
        }

    }

    private formatAuthors(authors: string) {
        return authors.replace(' and ', ', ')
            .replace(/Foreword([s]*)/g, ' foreword$1 ')
            .replace(/[W|w]ith chapters selected by/g, '')
            .replace('with', ', ')
            .replace(' and ', ', ')
            .replace(/([\s]*[,]+[\s]*)+/g, ', ')
            .replace(/[\s]+/g, ' ')
            .trim();
    }

    private getFileTypesData($: any, downloadSelection: any): { downloadName: string, downloadTypes: { id: number, name: number, fileType: string }[] } {
        let downloadInputElement = $('input[type="checkbox"]', downloadSelection)[0];
        if (downloadInputElement) {
            const downloadName = downloadInputElement.attribs['name'];
            let downloadTypes: { id: number, name: number, fileType: string }[] = [];
            for (let downloadFileData of $('div', downloadSelection)) {
                const id = $('input[type="hidden"]', downloadFileData)[0].attribs['id'];
                const name = $('input[type="hidden"]', downloadFileData).val();
                const fileType = $('input[type="checkbox"]', downloadFileData)[0].nextSibling.data.trim();
                downloadTypes.push({id: id, name: name, fileType: fileType});
            }
            return {downloadName: downloadName, downloadTypes: downloadTypes};
        }
        return undefined;
    }

    private getCodeSamplesUrl($: any, linkNode: any): string {
        if (linkNode != undefined) {
            return linkNode.attribs['href'];
        }
        return undefined;
    }

    private async downloadProduct(request: any, bookName: string, meapLastUpdate: string, fileExtension: string, downloadUrl: string, codeLink: string) {
        const bookNameAsPath: string = stringUtils.formatPathName(bookName);
        const downloadDir: string = `${this.booksDir}/${bookNameAsPath}`;
        const bookFileName: string = `${bookNameAsPath}${meapLastUpdate}.${fileExtension}`;

        if (!(await filesystemUtils.checkIfDirectoryExists(downloadDir))) {
            FS.mkdirSync(downloadDir);
        }
        if (!(await filesystemUtils.checkIfElementExists(downloadDir, bookFileName))) {
            await this.downloadFile(request, downloadUrl, timingUtils.ONE_SECOND * 3, downloadDir, bookFileName)
                .catch((error) => console.log(`${new Date().toISOString()} - ${error}`));
        } else {
            console.log(`${new Date().toISOString()} - No need to download '${bookFileName} - already downloaded`);
        }

        const codeFileName = `${bookNameAsPath}${meapLastUpdate}-CODE.zip`;
        if (codeLink && !(await filesystemUtils.checkIfElementExists(downloadDir, codeFileName))) {
            await this.downloadFile(request, codeLink, timingUtils.ONE_SECOND * 3, downloadDir, codeFileName)
                .catch((error) => console.log(`${new Date().toISOString()} - ${error}`));
        } else {
            console.log(`${new Date().toISOString()} - No need to download code samples for '${bookName} - already downloaded`);
        }
    }
}
