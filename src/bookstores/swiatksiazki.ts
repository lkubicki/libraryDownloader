'use strict';

import * as cheerio from "cheerio";
import * as FS from "fs";
import {Bookstore} from "./bookstore";
import {filesystemUtils} from "../utils/filesystemUtils";
import {stringUtils} from "../utils/stringUtils";

const ONE_SECOND: number = 1000;

export class SwiatKsiazki extends Bookstore {
    protected notLoggedInRedirectUrlPart: string = "login";

    protected async logIn(request: any): Promise<string> {
        let loginFormBody: string = await this.visitLoginForm(request, this.config.loginFormUrl);
        let formKey: string = await this.getLoginFormData(loginFormBody);
        console.log(`${new Date().toISOString()} - Logging in as ${this.config.login}`);
        return new Promise((resolve, reject) => {
            const postRequestOptions = {
                resolveWithFullResponse: true,
                form: {
                    form_key: formKey,
                    login: {
                        username: this.config.login,
                        password: this.config.password,
                    },
                    send: null
                }
            };
            request.post(this.config.loginServiceUrl, postRequestOptions)
                .then((response) => {
                    if (response.request.uri.href.indexOf(this.notLoggedInRedirectUrlPart) < 0) {
                        console.log(`${new Date().toISOString()} - Logged in as ${this.config.login}`);
                        resolve(response.body);
                    } else {
                        reject(`Could not log in as ${this.config.login}`);
                    }
                })
        });
    }

    private getLoginFormData(body: string): string {
        let $ = cheerio.load(body);
        return $('form.form-login input[name="form_key"]').val();
    }

    protected async getProducts(request: any, bookshelfPageBody: string) {
        let $ = await cheerio.load(bookshelfPageBody);
        for (let productPart of $('.downloadable-products-list .prod-info')) {
            const title: string = $('p.title a', productPart).text().replace(/\([a-z-]+\)?|"/g, '').trim();
            const authors: string = $('p.author a', productPart).text().replace(/\([a-z-]+\)?/g, '').trim();
            const downloadData: { fileType: string, downloadLink: string }[] = this.getDownloadData($, $('a.action.button.download', productPart));
            for (let download of downloadData) {
                try {
                    await this.downloadProduct(request, `${title} - ${authors}`, download.fileType, download.downloadLink)
                } catch (error) {
                    console.log(`${new Date().toISOString()} - Error downloading ${download.fileType} file for ${title} by ${authors} - ${error}`);
                }
            }
        }
    }

    private getDownloadData($: any, downloadButtons: any): { fileType: string, downloadLink: string }[] {
        let result: { fileType: string, downloadLink: string }[] = [];
        for (let downloadButton of downloadButtons) {
            const fileType: string = downloadButton.children[0].data.replace(/Pobierz|"/g, '').trim();
            const downloadLink: string = downloadButton.attribs['href'];
            result.push({fileType: fileType, downloadLink: downloadLink});
        }
        return result;
    }

    private async downloadProduct(request: any, bookName: string, fileExtension: string, downloadUrl: string) {
        const bookNameAsPath: string = stringUtils.formatPathName(bookName);
        const downloadDir: string = `${this.booksDir}/${bookNameAsPath}`;
        const bookFileName: string = `${bookNameAsPath}.${fileExtension}`;

        if (!(await filesystemUtils.checkIfDirectoryExists(downloadDir))) {
            FS.mkdirSync(downloadDir);
        }
        if (!(await filesystemUtils.checkIfElementExists(downloadDir, bookFileName))) {
            return this.downloadFile(request, downloadUrl, ONE_SECOND * 2, downloadDir, bookFileName);
        } else {
            console.log(`${new Date().toISOString()} - No need to download '${bookFileName} - already downloaded`);
        }
    }
}
