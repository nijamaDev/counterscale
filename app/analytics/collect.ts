import { UAParser } from "ua-parser-js";

import type { RequestInit } from "@cloudflare/workers-types";

// Cookieless visitor/session tracking
// Uses the approach described here: https://notes.normally.com/cookieless-unique-visitor-counts/

function getNextModifiedDate(current: Date | null, newVisit: boolean): Date {
    // in case date is an 'Invalid Date'
    if (current && isNaN(current.getTime())) {
        current = null;
    }

    const nextModifiedDate = new Date();

    if (!current || newVisit) {
        nextModifiedDate.setMilliseconds(0);
        return nextModifiedDate;
    }

    // update bounce (tracked in milliseconds)
    // 3 states of bounce: bounce (0), no bounce (1), done (2)
    switch (current.getMilliseconds()) {
        // if was bounce move to no bounce
        case 0:
            nextModifiedDate.setMilliseconds(1);
            break;
        // if was no bounce move to done
        case 1:
            nextModifiedDate.setMilliseconds(2);
            break;
        // set value 3 to indicate done with bounce
        default:
            nextModifiedDate.setMilliseconds(3);
            break;
    }

    return nextModifiedDate;
}

function getBounce(current: Date): number {
    // get bounce value (tracked in milliseconds, see getNextModifiedDate)
    // bounce (1), no bounce (-1), done (0)
    switch (current.getMilliseconds()) {
        case 0:
            return 1;
        case 1:
            return -1;
        default:
            return 0;
    }
}

function checkVisitorSession(ifModifiedSince: string | null): {
    newVisitor: boolean;
    newSession: boolean;
} {
    let newVisitor = true;
    let newSession = true;

    const minutesUntilSessionResets = 30;
    if (ifModifiedSince) {
        // check today is a new day vs ifModifiedSince
        const today = new Date();
        const ifModifiedSinceDate = new Date(ifModifiedSince);
        if (
            today.getFullYear() === ifModifiedSinceDate.getFullYear() &&
            today.getMonth() === ifModifiedSinceDate.getMonth() &&
            today.getDate() === ifModifiedSinceDate.getDate()
        ) {
            // if ifModifiedSince is today, this is not a new visitor
            newVisitor = false;
        }

        // check ifModifiedSince is less than 30 mins ago
        if (
            Date.now() - new Date(ifModifiedSince).getTime() <
            minutesUntilSessionResets * 60 * 1000
        ) {
            // this is a continuation of the same session
            newSession = false;
        }
    }

    return { newVisitor, newSession };
}

function extractParamsFromQueryString(requestUrl: string): {
    [key: string]: string;
} {
    const url = new URL(requestUrl);
    const queryString = url.search.slice(1).split("&");

    const params: { [key: string]: string } = {};

    queryString.forEach((item) => {
        const kv = item.split("=");
        if (kv[0]) params[kv[0]] = decodeURIComponent(kv[1]);
    });
    return params;
}

export function collectRequestHandler(request: Request, env: Env) {
    const params = extractParamsFromQueryString(request.url);

    const userAgent = request.headers.get("user-agent") || undefined;
    const parsedUserAgent = new UAParser(userAgent);

    parsedUserAgent.getBrowser().name;

    const ifModifiedSince = request.headers.get("if-modified-since");
    const { newVisitor, newSession } = checkVisitorSession(ifModifiedSince);
    const modifiedDate = getNextModifiedDate(
        ifModifiedSince ? new Date(ifModifiedSince) : null,
        newVisitor,
    );

    const data: DataPoint = {
        siteId: params.sid,
        host: params.h,
        path: params.p,
        referrer: params.r,
        newVisitor: newVisitor ? 1 : 0,
        newSession: newSession ? 1 : 0,
        bounce: getBounce(modifiedDate),
        // user agent stuff
        userAgent: userAgent,
        browserName: parsedUserAgent.getBrowser().name,
        deviceModel: parsedUserAgent.getDevice().model,
    };

    // NOTE: location is derived from Cloudflare-specific request properties
    // see: https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties
    const country = (request as RequestInit).cf?.country;
    if (typeof country === "string") {
        data.country = country;
    }

    writeDataPoint(env.WEB_COUNTER_AE, data);

    // encode 1x1 transparent gif
    const gif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const gifData = atob(gif);
    const gifLength = gifData.length;
    const arrayBuffer = new ArrayBuffer(gifLength);
    const uintArray = new Uint8Array(arrayBuffer);
    for (let i = 0; i < gifLength; i++) {
        uintArray[i] = gifData.charCodeAt(i);
    }

    return new Response(arrayBuffer, {
        headers: {
            "Content-Type": "image/gif",
            Expires: "Mon, 01 Jan 1990 00:00:00 GMT",
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
            "Last-Modified": modifiedDate.toISOString(),
            Tk: "N", // not tracking
        },
        status: 200,
    });
}

interface DataPoint {
    // index
    siteId?: string;

    // blobs
    host?: string | undefined;
    userAgent?: string;
    path?: string;
    country?: string;
    referrer?: string;
    browserName?: string;
    deviceModel?: string;

    // doubles
    newVisitor: number;
    newSession: number;
    bounce: number;
}

// NOTE: Cloudflare Analytics Engine has limits on total number of bytes, number of fields, etc.
// More here: https://developers.cloudflare.com/analytics/analytics-engine/get-started/#limits

export function writeDataPoint(
    analyticsEngine: AnalyticsEngineDataset,
    data: DataPoint,
) {
    const datapoint = {
        indexes: [data.siteId || ""], // Supply one index
        blobs: [
            data.host || "", // blob1
            data.userAgent || "", // blob2
            data.path || "", // blob3
            data.country || "", // blob4
            data.referrer || "", // blob5
            data.browserName || "", // blob6
            data.deviceModel || "", // blob7
            data.siteId || "", // blob8
        ],
        doubles: [data.newVisitor || 0, data.newSession || 0, data.bounce],
    };

    if (!analyticsEngine) {
        // no-op
        console.log("Can't save datapoint: Analytics unavailable");
        return;
    }

    analyticsEngine.writeDataPoint(datapoint);
}
