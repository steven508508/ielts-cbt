'use strict';
/**
 * 測試用的假 SMTP 伺服器。
 *
 * 只實作剛好夠測的指令，但該嚴格的地方照 RFC 嚴格：
 * 多行 EHLO 回應、沒 EHLO 就回 503、AUTH LOGIN 的 334/334/235。
 * 這樣才驗得出客戶端有沒有把指令順序搞錯。
 *
 * 不做真的 TLS 交握（測試環境沒有可信憑證）——
 * 收到 STARTTLS 就回 220 之後把連線切掉，
 * 讓測試可以檢查「STARTTLS 之前有沒有先 EHLO」而不必準備憑證。
 */
const net = require('net');

function startFakeSmtp({ offerStartTls = false, log = [] } = {}) {
  const session = (sock) => {
    let buf = '';
    let inData = false;
    let msg = '';
    let sawEhlo = false;
    let authStep = 0;                 // 1 = 等帳號，2 = 等密碼
    const w = (s) => sock.write(`${s}\r\n`);
    w('220 fake.smtp ESMTP ready');

    const line = (l) => {
      if (inData) {
        if (l === '.') {
          inData = false;
          log.push({ type: 'message', raw: msg });
          return w('250 2.0.0 Ok: queued as ABC123');
        }
        msg += `${l}\n`;
        return undefined;
      }
      if (authStep === 1) { authStep = 2; log.push({ type: 'user', value: Buffer.from(l, 'base64').toString() }); return w('334 UGFzc3dvcmQ6'); }
      if (authStep === 2) { authStep = 0; log.push({ type: 'pass', value: Buffer.from(l, 'base64').toString() }); return w('235 2.7.0 Authentication successful'); }

      log.push({ type: 'cmd', line: l });
      const up = l.toUpperCase();
      if (up.startsWith('EHLO') || up.startsWith('HELO')) {
        sawEhlo = true;
        const caps = ['250-fake.smtp', '250-SIZE 10485760', '250-8BITMIME'];
        if (offerStartTls) caps.push('250-STARTTLS');
        caps.push('250 AUTH LOGIN PLAIN');
        return w(caps.join('\r\n'));        // 多行回應：中間幾行是 250-
      }
      if (!sawEhlo) return w('503 5.5.1 Error: send HELO/EHLO first');
      if (up === 'STARTTLS') { w('220 2.0.0 Ready to start TLS'); return sock.destroy(); }
      if (up === 'AUTH LOGIN') { authStep = 1; return w('334 VXNlcm5hbWU6'); }
      if (up.startsWith('MAIL FROM')) return w('250 2.1.0 Ok');
      if (up.startsWith('RCPT TO')) return w('250 2.1.5 Ok');
      if (up === 'DATA') { inData = true; return w('354 End data with <CR><LF>.<CR><LF>'); }
      if (up === 'QUIT') { w('221 2.0.0 Bye'); return sock.end(); }
      return w('502 5.5.2 Unrecognized command');
    };

    sock.on('data', (c) => {
      buf += c.toString('utf8');
      let i = buf.indexOf('\n');
      while (i >= 0) {
        const l = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        line(l);
        i = buf.indexOf('\n');
      }
    });
    sock.on('error', () => { /* 測試中斷線是正常的 */ });
  };

  const server = net.createServer(session);
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => res({
      server, log, port: server.address().port,
      close: () => new Promise((r) => server.close(r)),
      cmds: () => log.filter((x) => x.type === 'cmd').map((x) => x.line.split(' ')[0].toUpperCase()),
    }));
  });
}

module.exports = { startFakeSmtp };
