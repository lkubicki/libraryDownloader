'use strict';

import * as cheerio from "cheerio";
import * as FS from "fs";
import * as xml2js from "xml2js"
import {Bookstore} from "./bookstore";
import {filesystemUtils} from "../utils/filesystemUtils";
import {timingUtils} from "../utils/timingUtils";
import {stringUtils} from "../utils/stringUtils";

export class InformIT extends Bookstore {
    protected notLoggedInRedirectUrlPart = "login.aspx";

    protected async logIn(request: any): Promise<string> {
        await this.visitLoginForm(request, this.config.loginFormUrl);
        console.log(`${new Date().toISOString()} - Logging in as ${this.config.login}`);

        const loginRequestOptions = {
            headers: {
                origin: this.config.mainServiceUrl,
                referer: this.config.bookshelfUrlAsReferer
            },
            form: {
                email_address: this.config.login,
                password: this.config.password
            },
            followRedirect: true,
            allowGetBody: true,
            methodRewriting: false,
        };

        return this.sendLoginForm(request, loginRequestOptions);
    }

    private mapFormat(format: string): string {
        switch (format) {
            case "Non-DRM eBook":
                return "pdf";
            case "eBook Multiformat":
            case "ePubs":
                return "epub";
        }
    }

    protected async getProducts(request: any, bookshelfPageBody: string) {
        const postRequestOptions = {
            headers: {
                origin: this.config.mainPageUrl,
                referer: this.config.bookshelfUrl
            },
            json: {
                productTypes: ""
            }
        };
        const products = await this.fetchProductsData(request, postRequestOptions, bookshelfPageBody);

        for (const product of products) {
            console.log(`${new Date().toISOString()} - Checking ${product.name}`);
            try {
                const fileName = stringUtils.formatPathName(product.name);
                const downloadDir = `${this.booksDir}${fileName}`;
                if (!(await filesystemUtils.checkIfElementExists(downloadDir, `${fileName}.${product.format}`))) {
                    console.log(`${new Date().toISOString()} - ${product.format} file for ${product.name} does not exists. Will download file`);
                    const generateResponse = await this.generateProduct(request, product.isbn13, product.nid, product.format);
                    await timingUtils.delay(timingUtils.ONE_SECOND * 2);
                    if (generateResponse.ready) {
                        console.log(`${new Date().toISOString()} - ${product.format} files for: ${product.name} generated. Downloading.`);
                        const downloadLink = this.prepareDownloadLink(product.isbn13, product.format, product.nid);
                        await this.downloadBook(request, downloadLink, product.name, product.format);
                    } else {
                        console.log(`${new Date().toISOString()} - Could not prepare ${product.format} file for: ${product.name} - ${generateResponse.error}`);
                    }
                } else {
                    console.log(`${new Date().toISOString()} - No need to download ${product.format} file for: ${product.name} - file already exists`);
                }
            } catch (error) {
                console.log(`${new Date().toISOString()} - Error getting product: ${error}`);
            }
        }
    }

    private async fetchProductsData(request: any, postRequestOptions: {
        headers: { origin: any; referer: any };
        json: { productTypes: string }
    }, bookshelfPageBody: string) {
        console.log(`${new Date().toISOString()} - Fetching digital products list`);
        const digitalProductsResponse = await request.post(this.config.userDigitalProductsServiceUrl, postRequestOptions);
        const digitalProducts = JSON.parse(digitalProductsResponse.body);
        const productsData = digitalProducts["d"]["DigitalProduct"];
        const formatsMap = digitalProducts["d"]["Formats"]
            .map(formatData => ({
                productId: formatData.product_id,
                isbn13: formatData.child_isbn13,
                format: this.mapFormat(formatData.product_type)
            }))
            .reduce((map, formatData) => {
                if (!map.has(formatData.productId)) {
                    map.set(formatData.productId, []);
                }
                map.get(formatData.productId).push(formatData);
                return map;
            }, new Map());

        const nid = this.fetchNetworkId(bookshelfPageBody);

        return productsData.map(product => ({
            productId: product.product_id,
            name: product.product_name,
            nid: nid,
        })).flatMap(product => {
            const formats = formatsMap.get(product.productId) || [];
            return formats.map(formatData => ({
                ...product,
                isbn13: formatData.isbn13,
                format: formatData.format
            }));
        });
    }

    private fetchNetworkId(bookshelfPageBody: string): string {
        const $ = cheerio.load(bookshelfPageBody);
        for (let scriptElement of $(".wrapper script:not([src])")) {
            const scriptBody = (scriptElement.children[0] as unknown as Text).data;
            const matched = scriptBody.match("networkID = \'[a-zA-Z0-9-]+\';")[0].trim();
            const nid = matched.replace(/networkID\s+=\s+'/g, "").replace(/';/g, "");
            if (nid != null && nid != "") {
                return nid;
            }
        }
        return null;
    }

    private prepareDownloadLink(isbn13: string, fileFormat: string, nid: string): string {
        const mapObj = {
            _fileFormat_: fileFormat,
            _isbn_: isbn13,
            _nid_: nid
        };
        return this.config.downloadServiceUrl.replace(/_fileFormat_|_isbn_|_nid_/gi, function (matched) {
            return mapObj[matched];
        });
    }

    private async generateProduct(request: any, isbn: string, nid: string, fileType: string): Promise<{
        ready: boolean;
        error: string
    }> {
        const postRequestOptions = {
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                "x-requested-with": "XMLHttpRequest",
                "host": "memberservices.informit.com",
                dnt: 1
            },
            form: {
                isbn13: isbn.trim(),
                nid: nid.trim(),
                format: fileType.trim()
            }
        };
        console.log(`${new Date().toISOString()} - Started generating ${fileType} file`);
        const xmlParser = new xml2js.Parser();
        let postResult = await request.post(this.config.generateProductServiceUrl, postRequestOptions);
        const postResponse = await xmlParser.parseStringPromise(postResult.body);
        if (postResponse.Result.RequestSuccess[0] == "True") {
            return await this.waitUntilGenerated(request, postRequestOptions, xmlParser);
        } else {
            console.log(`${new Date().toISOString()} - Cannot generate ${fileType} file`);
            return ({ready: false, error: `Cannot generate ${fileType} file`});
        }
    }

    private async waitUntilGenerated(request: any, postRequestOptions: {
        form: { isbn13: string; nid: string; format: string }
    }, xmlParser: xml2js.Parser) {
        const MAX_RETRY = 60;
        let counter: number = 0;
        let delay: number = timingUtils.ONE_SECOND * 2;
        const requestOptions = {
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                "x-requested-with": "XMLHttpRequest",
                "host": "memberservices.informit.com",
                dnt: 1
            },
            body: "isbn13=" + postRequestOptions["form"]["isbn13"] + "&nid=" + postRequestOptions["form"]["nid"] + "&format=" + postRequestOptions["form"]["format"]
        }
        let response;
        do {
            await timingUtils.delayExactly(delay);
            const responseXml = await request.post(this.config.productStatusServiceUrl, requestOptions);
            response = await xmlParser.parseStringPromise(responseXml.body);
            console.log(`${new Date().toISOString()} - Waiting for ${postRequestOptions.form.format} file to be generated: attempt ${counter} - RequestSuccess ${response.Result.RequestSuccess[0]}, GenerationCompleted ${response.Result.GenerationCompleted[0]}`);
            counter++;
        } while (response.Result.GenerationCompleted[0] == "False" && counter < MAX_RETRY);
        if (counter <= MAX_RETRY && response.Result.GenerationCompleted[0] == "True") {
            return ({ready: true, error: null});
        } else {
            return ({
                ready: false,
                error: `Gave up generating ${postRequestOptions.form.format} file after ${MAX_RETRY} requests`
            });
        }
    }

    private async downloadBook(request: any, downloadLink, title: string, fileFormat: string) {
        const bookName: string = stringUtils.formatPathName(`${title}`);
        const downloadDir = `${this.booksDir}/${bookName}`;
        if (!(await filesystemUtils.checkIfDirectoryExists(downloadDir))) {
            FS.mkdirSync(downloadDir);
        }
        const fileName = `${bookName}.${fileFormat}`;
        if (!(await filesystemUtils.checkIfElementExists(downloadDir, fileName))) {
            return this.downloadFile(request, downloadLink, timingUtils.ONE_SECOND * 3, downloadDir, fileName);
        } else {
            console.log(`${new Date().toISOString()} - No need to download ${fileFormat} file for ${bookName} - already downloaded`);
        }
    }
}
