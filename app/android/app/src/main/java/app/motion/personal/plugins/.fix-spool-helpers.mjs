import { readFileSync, writeFileSync } from 'node:fs';
const p = 'ExportSpool.java';
let s = readFileSync(p, 'utf8');
const anchor = '    /**\n     * 读取暂存文件真实字节（写入后回读校验用）。';
if (!s.includes(anchor)) { console.log('ANCHOR NOT FOUND'); process.exit(1); }
const insert = `    /** 暂存文件当前字节数（int 版；供短元数据绑定） */
    public int stagedLengthInt(String token) throws IOException {
        long n = stagedLength(token);
        if (n > Integer.MAX_VALUE) throw new IOException("暂存文件过大");
        return (int) n;
    }

    /** 暂存文件内容的 SHA-256（供短元数据绑定，写入后完整性核对） */
    public String sha256Of(String token) throws IOException {
        return sha256Hex(readBytes(token));
    }

`;
s = s.replace(anchor, insert + anchor);
writeFileSync(p, s, 'utf8');
console.log('OK: spool helpers inserted');
