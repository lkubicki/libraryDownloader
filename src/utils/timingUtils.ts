"use strict";

export class timingUtils {
    public static async delay(delay: number) {
        return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * delay / 2) + delay / 2));
    }

    public static async delayExactly(delay: number) {
        return new Promise(resolve => setTimeout(resolve, delay));
    }
}