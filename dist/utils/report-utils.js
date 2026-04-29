import { gunzipSync } from 'zlib';
export function decompressIfNeeded(data) {
    if (Buffer.isBuffer(data)) {
        if (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b && data[2] === 0x08) {
            try {
                return gunzipSync(data).toString('utf-8');
            }
            catch {
                return data.toString('utf-8');
            }
        }
        return data.toString('utf-8');
    }
    if (typeof data === 'string') {
        if (data.charCodeAt(0) === 0x1f && data.charCodeAt(1) === 0x8b && data.charCodeAt(2) === 0x08) {
            try {
                return gunzipSync(Buffer.from(data, 'binary')).toString('utf-8');
            }
            catch {
                return data;
            }
        }
        return data;
    }
    return JSON.stringify(data);
}
export function parseCSVReport(csvData, reportType) {
    if (!csvData)
        return { reportType, headers: [], rows: [], rowCount: 0 };
    const lines = csvData.split('\n').filter(l => l.trim());
    if (lines.length === 0)
        return { reportType, headers: [], rows: [], rowCount: 0 };
    const headers = lines[0].split('\t').map(h => h.trim());
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split('\t');
        const row = {};
        headers.forEach((header, idx) => {
            row[header] = values[idx] ? values[idx].trim() : '';
        });
        row._proceedsUSD = parseFloat(row['Developer Proceeds'] || row['Proceeds'] || '0');
        rows.push(row);
    }
    return { reportType, headers, rows, rowCount: rows.length };
}
//# sourceMappingURL=report-utils.js.map