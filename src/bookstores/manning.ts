'use strict';

import * as cheerio from "cheerio";
import * as FS from "fs";
import {Bookstore} from "./bookstore";
import {filesystemUtils} from "../utils/filesystemUtils";
import {stringUtils} from "../utils/stringUtils";
import {timingUtils} from "../utils/timingUtils";

export class Manning extends Bookstore {
    protected notLoggedInRedirectUrlPart: string = "login";

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
        const lt = $('form input[name="lt"]').val();
        const execution = $('form input[name="execution"]').val();
        const eventId = $('form input[name="_eventId"]').val();
        return {lt: lt, execution: execution, eventId: eventId};
    }

    protected async getProducts(request: any, bookshelfPageBody: string) {
        let booksListBody = await this.getPageBody(request, this.config.booksListUrl, 0);
        booksListBody = `<html><body><table>${booksListBody}</table></body></html>`;
        let $ = await cheerio.load(booksListBody);
        for (let productPart of $('tr.license-row')) {
            await timingUtils.delayExactly(timingUtils.ONE_SECOND);
            const title = $('div.product-title', productPart).text().trim();
            const authors = this.formatAuthors($('div.product-authorship', productPart).text());
            const fileTypes = this.getFileTypesData($, $('div.download-selection', productPart));
            let downloadElement = $('form.download-form', productPart)[0];
            let input = $('input[id="productExternalId"]', productPart)[0];
            const downloadUrl = downloadElement != undefined ? `${this.config.mainPageUrl}/${downloadElement.attribs['action']}` : undefined;
            const externalId = input != undefined ? input.attribs['value'] : undefined;
            const codeLink = this.getCodeSamplesUrl($, $('.links a[title="download code samples"]', productPart)[0]);
            if (fileTypes && externalId) {
                try {
                    let downloadParameters = {
                        dropbox: false,
                        productExternalId: externalId
                    };
                    downloadParameters[fileTypes.downloadName] = [];
                    for (let fileType of fileTypes.downloadTypes) {
                        downloadParameters[fileTypes.downloadName].push(fileType.id);
                        downloadParameters[fileType.id] = fileType.name;
                    }
                    let fileExtension: string = (fileTypes.downloadTypes.length > 1 ? 'zip' : fileTypes.downloadTypes[0].fileType);
                    console.log(`${new Date().toISOString()} - Downloading '${title}' by ${authors}`);
                    await this.downloadProduct(request, `${title} - ${authors}`, fileExtension, downloadUrl, downloadParameters, codeLink);
                } catch (error) {
                    console.log(`${new Date().toISOString()} - Could not download '${title}' by ${authors} - error: ${error}`);
                }
            } else {
                console.log(`${new Date().toISOString()} - Could not download '${title}' by ${authors} - extenalId value not found`);
            }
        }
    }

    private formatAuthors(authors: string) {
        return authors.replace(' and ', ', ')
            .replace(/Foreword([s]*)/g, ' foreword$1 ')
            .replace('With chapters selected by ', '')
            .replace(/([,]+[\s]*)+/g, ', ')
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

    private async downloadProduct(request: any, bookName: string, fileExtension: string, downloadUrl: string, downloadParameters: { dropbox: boolean; productExternalId: any }, codeLink: string) {
        const bookNameAsPath: string = stringUtils.formatPathName(bookName);
        const downloadDir: string = `${this.booksDir}/${bookNameAsPath}`;
        const bookFileName: string = `${bookNameAsPath}.${fileExtension}`;

        if (!(await filesystemUtils.checkIfDirectoryExists(downloadDir))) {
            FS.mkdirSync(downloadDir);
        }
        if (!(await filesystemUtils.checkIfElementExists(downloadDir, bookFileName))) {
            await this.downloadBookFile(request, downloadDir, bookFileName, downloadUrl, downloadParameters)
                .catch((error) => console.log(`${new Date().toISOString()} - ${error}`));
        } else {
            console.log(`${new Date().toISOString()} - No need to download '${bookFileName} - already downloaded`);
        }

        const codeFileName = `${bookNameAsPath}-CODE.zip`;
        if (codeLink && !(await filesystemUtils.checkIfElementExists(downloadDir, codeFileName))) {
            await this.checkSizeAndDownloadFile(request, codeLink, timingUtils.ONE_SECOND * 3, downloadDir, codeFileName)
                .catch((error) => console.log(`${new Date().toISOString()} - ${error}`));
        } else {
            console.log(`${new Date().toISOString()} - No need to download code samples for '${bookName} - already downloaded`);
        }
    }

    private async downloadBookFile(request: any, downloadDir: string, fileName: string, downloadUrl: string, downloadParameters: { dropbox: boolean; productExternalId: any }) {
        return new Promise((resolve, reject) => {
            console.log(`${new Date().toISOString()} - Downloading ${fileName}`);
            let postOptions = {
                form: downloadParameters, qsStringifyOptions: {arrayFormat: 'repeat'}
            };
            let stream = request.post(downloadUrl, postOptions)
                .pipe(FS.createWriteStream(`${downloadDir}/${fileName}`))
                .on('finish', () => {
                    console.log(`${new Date().toISOString()} - ${fileName} downloaded`);
                    resolve();
                })
                .on('error', (error) => {
                    reject(`Error getting product: ${error}`);
                });
        });
    }
}
