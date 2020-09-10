const path = require('path');
const stylish = require('eslint/lib/cli-engine/formatters/stylish');
const got = require('got');
const globalTunnel = require('global-tunnel');

const { BITBUCKET_WORKSPACE, BITBUCKET_REPO_SLUG, BITBUCKET_COMMIT, BITBUCKET_API_AUTH } = process.env;

const BITBUCKET_API_HOST = 'api.bitbucket.org/2.0/';

const MAX_ANNOTATIONS_PER_REQUEST = 100;

const httpClientConfig = BITBUCKET_API_AUTH ? {
    prefixUrl: `https://${BITBUCKET_API_HOST}`,
    responseType: 'json',
    headers: {
        'Authorization': BITBUCKET_API_AUTH
    }
} : {
    prefixUrl: `http://${BITBUCKET_API_HOST}`,
    responseType: 'json',
    headers: {
        'User-Agent': 'curl/7.38.0',
        'Accept': '*/*',
        'Proxy-Connection': 'Keep-Alive'
    }
}

if (!BITBUCKET_API_AUTH) {
    globalTunnel.initialize({
        host: 'localhost',
        port: 29418,
    });
}

const httpClient = got.extend(httpClientConfig);

const SEVERITIES = {
    1: 'MEDIUM',
    2: 'HIGH'
};

function generateReport(results) {
    const summary = results.reduce(
        (acc, current) => {
            acc.errorCount += current.errorCount;
            acc.warningCount += current.warningCount;
            return acc;
        },
        { errorCount: 0, warningCount: 0 }
    );
    
    const { errorCount, warningCount } = summary;
    const problemCount = errorCount + warningCount;
    
    const details = `${problemCount} problem${problemCount !== 1 ? 's' : ''} (${errorCount} error${errorCount !== 1 ? 's' : ''}, ${warningCount} warning${warningCount !== 1 ? 's' : ''})`;
    const result = errorCount > 0 ? 'FAILED' : 'PASSED';

    return {
        title: 'ESLint report',
        reporter: 'ESLint',
        report_type: 'TEST',
        details,
        result
    };
}

function generateAnnotations(results, reportId) {
    return results.reduce((acc, result) => {
        const relativePath = path.relative(process.cwd(), result.filePath);
        return [...acc, ...result.messages.map(messageObject => {
            const { line, message, severity, ruleId } = messageObject;
            const external_id = `${reportId}-${relativePath}-${line}-${ruleId}`;
            return {
                external_id,
                line,
                path: relativePath,
                summary: `${message} (${ruleId})`,
                annotation_type: 'BUG',
                severity: SEVERITIES[severity]
            };
        })];
    }, []);
}

async function deleteReport(reportId) {
    return httpClient.delete(`repositories/${BITBUCKET_WORKSPACE}/${BITBUCKET_REPO_SLUG}/commit/${BITBUCKET_COMMIT}/reports/${reportId}`);
}

async function createReport(reportId, report) {
    return httpClient.put(`repositories/${BITBUCKET_WORKSPACE}/${BITBUCKET_REPO_SLUG}/commit/${BITBUCKET_COMMIT}/reports/${reportId}`, {
        json: report,
        responseType: 'json'
    });
}

async function createAnnotations(reportId, annotations) {
    const chunk = annotations.slice(0, MAX_ANNOTATIONS_PER_REQUEST);
    const response = await httpClient.post(`repositories/${BITBUCKET_WORKSPACE}/${BITBUCKET_REPO_SLUG}/commit/${BITBUCKET_COMMIT}/reports/${reportId}/annotations`, {
        json: chunk,
        responseType: 'json'
    });
    if (annotations.length > MAX_ANNOTATIONS_PER_REQUEST) {
        return createAnnotations(reportId, annotations.slice(MAX_ANNOTATIONS_PER_REQUEST));
    }
    return response;
}

async function processResults(results) {
    const reportId = `eslint-${BITBUCKET_COMMIT}`;
    const report = generateReport(results);
    const annotations = generateAnnotations(results, reportId);

    try {
        const response = await httpClient.get(`repositories/${BITBUCKET_WORKSPACE}/${BITBUCKET_REPO_SLUG}/commit/${BITBUCKET_COMMIT}/reports`);
        console.log(response);

        await deleteReport(reportId);
        await createReport(reportId, report);
        await createAnnotations(reportId, annotations);
    } catch (error) {
        if (error.request) {
            console.log(error.request.options);
        }
        if (error.response) {
            console.error(error.message, error.response.body)
        } else {
            console.error(error);
        }
    }
}

module.exports = function(results) {
    processResults(results);
    return stylish(results);
};