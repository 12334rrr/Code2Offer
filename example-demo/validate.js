// 输入校验:所有写操作的边界都在这里把关
'use strict';

const ALLOWED_STATUS = ['todo', 'doing', 'done'];

function validateTaskInput(body, partial = false) {
  const errors = [];
  if (typeof body !== 'object' || body === null) return ['请求体必须是 JSON 对象'];
  if (!partial || body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim().length === 0) {
      errors.push('title 必须是非空字符串');
    } else if (body.title.length > 200) {
      errors.push('title 过长(>200)');
    }
  }
  if (body.status !== undefined && !ALLOWED_STATUS.includes(body.status)) {
    errors.push(`status 必须是 ${ALLOWED_STATUS.join('/')}`);
  }
  if (body.assignee !== undefined && body.assignee !== null && typeof body.assignee !== 'string') {
    errors.push('assignee 必须是字符串或 null');
  }
  if (body.dueAt !== undefined && body.dueAt !== null) {
    if (typeof body.dueAt !== 'string' || Number.isNaN(Date.parse(body.dueAt))) {
      errors.push('dueAt 必须是可解析的日期字符串');
    }
  }
  return errors;
}

module.exports = { validateTaskInput, ALLOWED_STATUS };
