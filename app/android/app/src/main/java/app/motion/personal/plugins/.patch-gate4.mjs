import { readFileSync, writeFileSync } from 'node:fs';
const p = 'NativeFileBridgePlugin.java';
let s = readFileSync(p, 'utf8');
const log = [];
function rep(name, from, to) {
  if (!s.includes(from)) { log.push(`SKIP ${name}`); return; }
  s = s.replace(from, to);
  log.push(`OK   ${name}`);
}

rep('import cancel release',
`        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.setKeepAlive(false);
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }`,
`        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            releaseOperation();
            call.setKeepAlive(false);
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }`);

rep('import no-uri release',
`        final Uri uri = result.getData().getData();
        if (uri == null) {
            call.setKeepAlive(false);
            call.reject("系统没有返回可读取的文件", "NO_URI");
            return;
        }`,
`        final Uri uri = result.getData().getData();
        if (uri == null) {
            releaseOperation();
            call.setKeepAlive(false);
            call.reject("系统没有返回可读取的文件", "NO_URI");
            return;
        }`);

rep('import thread release',
`                            } catch (BackupIo.TooLargeException e) {
                                call.reject(e.getMessage(), "TOO_LARGE", e);
                            } catch (Exception e) {
                                call.reject("读取文件失败：" + BackupIo.describe(e), "READ_FAILED", e);
                            }`,
`                            } catch (BackupIo.TooLargeException e) {
                                releaseOperation();
                                call.reject(e.getMessage(), "TOO_LARGE", e);
                            } catch (Exception e) {
                                releaseOperation();
                                call.reject("读取文件失败：" + BackupIo.describe(e), "READ_FAILED", e);
                            } finally {
                                releaseOperation();
                            }`);

writeFileSync(p, s, 'utf8');
console.log(log.join('\n'));
