'use strict';

import {Programista} from "../bookstores/programista";

export class ProgramistaJunior extends Programista {
    protected readonly LOGIN_REDIRECT_PAGE = "https://programistajr.pl/wp-admin/";
    protected readonly ISSUE_REGEXP = /^Programista Junior [0-9]+\/[0-9]+/;
    protected readonly ISSUE_NBR_REGEXP = /^(Programista\sJunior) ([0-9]+)\/([0-9]+)/;

    protected getFileMetadata(magazineFileName: string, magazineFileUrl: string): { fileName: string, fileExtension: string, fileUrl: string } {
        let fileExtension = magazineFileName.match(/[A-Z]+$/)[0];
        return {
            fileExtension: fileExtension,
            fileName: magazineFileName.replace(fileExtension.toUpperCase(), '').replace(/[\s]+/gi, ' ').replace(/[\s]+$/gi, ''),
            fileUrl: magazineFileUrl
        };
    }
}
