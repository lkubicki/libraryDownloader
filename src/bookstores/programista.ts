'use strict';

import * as cheerio from "cheerio";
import * as FS from "fs";
import {Bookstore} from "./bookstore";
import {filesystemUtils} from "../utils/filesystemUtils";
import {stringUtils} from "../utils/stringUtils";
import {timingUtils} from "../utils/timingUtils";

export class Programista extends Bookstore {
    protected notLoggedInRedirectUrlPart = "/login/";

    private readonly PROGRAMISTA_POSITION = 1;
    private readonly MONTH_POSITION = 2;
    private readonly YEAR_POSITION = 3;

    protected readonly LOGIN_REDIRECT_PAGE: string = "https://programistamag.pl/wp-admin/";
    protected readonly ISSUE_REGEXP = /^Programista [0-9]+\/[0-9]+/;
    protected readonly ISSUE_NBR_REGEXP = /^(Programista) ([0-9]+)\/([0-9]+)/;


    protected async logIn(request: any): Promise<string> {
        await this.visitLoginForm(request, this.config.loginFormUrl);
        console.log(`${new Date().toISOString()} - Logging in as ${this.config.login}`);

        const loginRequestOptions = {
            form:
                {
                    _wp_original_http_referer: this.config.mainPageUrl,
                    log: this.config.login,
                    pwd: this.config.password,
                    "wp-submit": "Zaloguj się",
                    redirect_to: this.LOGIN_REDIRECT_PAGE,
                    instance: "",
                    action: "login"
                },
            followRedirect: false
        };
        return this.sendLoginForm(request, loginRequestOptions);
    }

    protected async getProducts(request: any, bookshelfPageBody: string) {
        const $ = cheerio.load(bookshelfPageBody);
        for (let magazineElement of $(".panel-body.panel-dlc")) {
            await this.downloadIssue(request, $, magazineElement);
        }
    }

    private async downloadIssue(request: any, $: any, magazineElement: any) {
        const issueNameData: { oldName: string, correctedName: string } = this.getIssueTitle($, magazineElement);

        const issueName: string = stringUtils.formatPathName(`${issueNameData.correctedName}`);
        console.log(`${new Date().toISOString()} - Found ${issueName}`);

        const downloadDir = `${this.booksDir}/${issueName}`;
        if (!(await filesystemUtils.checkIfDirectoryExists(downloadDir))) {
            FS.mkdirSync(downloadDir);
        }

        for (let magazineIssueElement of $("tr td", magazineElement)) {
            if ($(magazineIssueElement).siblings(".file-asset, .file-media").length) {
                const magazineFileLinkElement = $("a", magazineIssueElement);
                const magazineFileName = magazineFileLinkElement.text().replace(issueNameData.oldName, issueNameData.correctedName);
                const magazineFileUrl = magazineFileLinkElement[0].attribs['href'];
                const fileData: { fileName: string, fileExtension: string, fileUrl: string } = this.getFileMetadata(magazineFileName, magazineFileUrl);
                try {
                    await this.downloadIssueFile(request, downloadDir, fileData)
                } catch (error) {
                    console.log(`${new Date().toISOString()} - ${error}`);
                }
            }
        }
    }

    private getIssueTitle($: any, magazineElement: any): { oldName: string, correctedName: string } {
        for (let element of $("tr td a", magazineElement)) {
            try {
                const elementText = $(element).text().trim();
                if (this.ISSUE_REGEXP.test(elementText)) {
                    return {
                        oldName: elementText.replace(/PDF|EPUB|MOBI|AZW3|Single|Double|page|[\s]+/gi, ' ').trim(),
                        correctedName: this.createIssueName(elementText)
                    };
                }
            } catch (error) {
                console.log(error);
            }
        }
        return null;
    }

    private createIssueName(elementText: string): string {
        const matchArray = elementText.match(this.ISSUE_NBR_REGEXP);
        const monthText = stringUtils.formatDigit(matchArray[this.MONTH_POSITION], 2);
        return `${matchArray[this.PROGRAMISTA_POSITION]} ${matchArray[this.YEAR_POSITION]}-${monthText}`;
    }

    private getFileMetadata(magazineFileName: string, magazineFileUrl: string): { fileName: string, fileExtension: string, fileUrl: string } {
        let fileExtension = magazineFileUrl.match(/[a-zA-Z0-9]+$/)[0];
        return {
            fileExtension: fileExtension,
            fileName: magazineFileName.replace(fileExtension.toUpperCase(), '').replace(/[\s]+/gi, ' ').replace(/[\s]+$/gi, ''),
            fileUrl: magazineFileUrl
        };
    }

    private async downloadIssueFile(request: any, downloadDir: string, fileData: { fileName: string; fileExtension: string; fileUrl: string }) {
        const fileName = stringUtils.formatPathName(`${fileData.fileName}.${fileData.fileExtension}`);

        if (!(await filesystemUtils.checkIfElementExists(downloadDir, fileName))) {
            return this.downloadFile(request, fileData.fileUrl, timingUtils.ONE_SECOND * 3, downloadDir, fileName);
        } else {
            console.log(`${new Date().toISOString()} - No need to download ${fileName} - already downloaded`);
        }
    }
}
