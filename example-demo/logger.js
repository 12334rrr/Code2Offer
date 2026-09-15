// 分级日志器:json 行格式,便于采集
'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(level) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  function write(lv, msg, extra) {
    if (LEVELS[lv] < threshold) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: lv,
      msg,
      ...(extra && typeof extra === 'object' ? extra : { extra }),
    });
    process.stdout.write(line + '\n');
  }
  return {
    debug: (m, e) => write('debug', m, e),
    info: (m, e) => write('info', m, e),
    warn: (m, e) => write('warn', m, e),
    error: (m, e) => write('error', m, e),
  };
}

module.exports = { createLogger, LEVELS };
