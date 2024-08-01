import * as cheerio from "cheerio";
import * as FS from "fs";
import "form-data";
import {Bookstore} from "./bookstore";
import {timingUtils} from "../utils/timingUtils";
import {filesystemUtils} from "../utils/filesystemUtils";
import {stringUtils} from "../utils/stringUtils";

export class Springer extends Bookstore {
    protected notLoggedInRedirectUrlPart = "idp-personal-authenticator";

    protected async logIn(request: any): Promise<string> {
        let loginFormPageBody =
            await this.visitBookshelf(request, this.config.bookshelfUrl);
        await timingUtils.delay(timingUtils.ONE_SECOND);
        console.log(`${new Date().toISOString()} - Logging in as ${this.config.login}`);

        let loginData = this.findLoginData(loginFormPageBody, 'form-email-submit');
        loginData.set("user_id", this.config.login);
        const loginRequestOptions = this.prepareLoginFormData(loginData);
        await timingUtils.delay(timingUtils.ONE_SECOND * 3);
        let loginUrl = this.config.loginHost + loginData.get('actionUrl');
        console.log(`${new Date().toISOString()} - Sending email form`);
        let usernameFormRespone = await this.sendLoginFormAtUrl(request, loginUrl, loginRequestOptions);

        let loginPasswordFormData = this.findLoginData(usernameFormRespone, 'form-password-submit');
        loginPasswordFormData.set("password", this.config.password);
        const loginPasswordRequestOptions = this.preparePasswordFormData(loginPasswordFormData);
        let passwordUrl = this.config.loginHost + loginPasswordFormData.get('actionUrl');
        console.log(`${new Date().toISOString()} - Sending password form`);
        let passwordFormResponse = await this.sendLoginFormAtUrl(request, passwordUrl, loginPasswordRequestOptions)

        return new Promise((resolve, reject) => {
            this.checkIfUserIsLoggedIn(request)
                .then((checkResult) => {
                    if (checkResult.isLoggedIn) {
                        console.log(`${new Date().toISOString()} - Logged in as ${this.config.login}`);
                        resolve(checkResult.body);
                    } else {
                        reject(`Could not log in as ${this.config.login} - ${checkResult.body}`);
                    }
                }).catch((error) => {
                reject(`Could not check if ${this.config.login} is logged in. Error: ${error}`);
            });
        })
    }

    private preparePasswordFormData(loginData: Map<string, string>) {
        const loginPasswordRequestOptions = {
            contentType: 'application/x-www-form-urlencoded',
            resolveWithFullResponse: true,
            followRedirect: true,
            allowGetBody: true,
            methodRewriting: false,
            form: {
                passwd: loginData.get("password"),
                responseType: loginData.get("responseType"),
                prefilledUserId: "",
                _csrf: loginData.get("_csrf"),
                redirectUri: loginData.get("redirectUri"),
                target: loginData.get("target"),
                state: loginData.get("state"),
                attributes: loginData.get("attributes")
            }
        };
        return loginPasswordRequestOptions;
    }

    private prepareLoginFormData(loginData: Map<string, string>) {
        const loginRequestOptions = {
            contentType: 'application/x-www-form-urlencoded',
            resolveWithFullResponse: true,
            followRedirect: true,
            allowGetBody: true,
            methodRewriting: false,
            form: {
                user_id: loginData.get("user_id"),
                responseType: loginData.get("responseType"),
                prefilledUserId: "",
                _csrf: loginData.get("_csrf"),
                state: loginData.get("state"),
                redirectUri: loginData.get("redirectUri"),
                target: loginData.get("target")
            }
        };
        return loginRequestOptions;
    }

    protected sendLoginFormAtUrl(request: any, loginUrl: string, postRequestOptions: object): Promise<string> {
        return new Promise((resolve, reject) => {
            request.post(loginUrl, postRequestOptions)
                .then((response) => {
                    resolve(response.body);
                })
                .catch((error) => {
                    reject(`Could not log in as ${this.config.login}. Error: ${error}`);
                })
        });
    }

    protected async getProducts(request: any, bookshelfPageBody: string) {
        let $ = await cheerio.load(bookshelfPageBody);
        for (let productPart of $('.products ul li .product-information')) {
            const bookTitle = this.getBookTitle($, productPart);
            const bookAuthors = this.getBookAuthors($, productPart);
            console.log(`${new Date().toISOString()} - Getting download url for '${bookTitle}' by ${bookAuthors}`);
            const downloads = await this.getBookDownloads(request, $, productPart, bookTitle);
            for (let download of downloads) {
                try {
                    await this.downloadBook(request, `${bookTitle} - ${bookAuthors}`, download);
                } catch (error) {
                    console.log(`${new Date().toISOString()} - Could not download ${download.fileType} file for '${bookTitle}' by ${bookAuthors} - ${error}`);
                }
            }
            // } catch (error) {
            //     console.log(`${new Date().toISOString()} - Could not get download url for ${download.fileType} file for '${bookTitle}' by ${bookAuthors} - ${error}`);
            // }
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
            for (let i = 0; i < bookAuthorsData.length; i++) {
                bookAuthorsData[i] = bookAuthorsData[i].trim();
            }
            authors += bookAuthorsData.join(', ');
        }
        return authors.replace(/\s+/g, ' ').trim();
    }

    private async getBookDownloads(request: any, $: any, productPart: any, bookTitle: string): Promise<{
        fileType: string;
        downloadLink: string
    }[]> {
        let downloads: { fileType: string; downloadLink: string }[] = [];
        for (let downloadData of $('.bar-download-actions a.download', productPart)) {
            const downloadLinkText = $(downloadData).text();
            let fileType: string = (downloadLinkText != undefined ? downloadLinkText.replace('Download', '').trim() : "");
            try {
                const downloadUrl = await this.getPageBody(request, `${this.config.mainPageUrl}${downloadData.attribs['href']}`, timingUtils.ONE_SECOND);
                downloads.push({fileType: fileType, downloadLink: downloadUrl});
            } catch (error) {
                console.log(`${new Date().toISOString()} - Could not get download url for ${fileType} file for ${bookTitle} - ${error}`);
            }
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
            console.log(`${new Date().toISOString()} - Getting ${download.fileType} file for ${bookName}`);
            await this.downloadFile(request, download.downloadLink, timingUtils.ONE_SECOND * 3, downloadDir, bookFileName, false);
        } else {
            console.log(`${new Date().toISOString()} - No need to download ${download.fileType} file for ${bookName} - file already downloaded`);
        }
    }

    private findLoginData(loginFormUsernamePageBody: string, formId: string): Map<string, string> {
        let $ = cheerio.load(loginFormUsernamePageBody);
        let loginData: Map<string, string> = new Map<string, string>();
        for (let hiddenInput of $('input[type="hidden"]')) {
            if (hiddenInput.attribs['value'] !== '') {
                loginData.set(hiddenInput.attribs['name'], hiddenInput.attribs['value']);
            }
        }
        let form = $(`form#${formId}`).get(0);
        loginData.set('actionUrl', form.attribs['action'])
        return loginData;
    }

}
