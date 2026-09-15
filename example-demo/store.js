// 数据访问层:内存表 + 二级索引(等价于一个微型数据库)
'use strict';

class TaskStore {
  constructor() {
    this.nextId = 1;
    this.rows = new Map(); // id -> task
    this.indexByStatus = new Map(); // status -> Set<id>
    this.indexByAssignee = new Map(); // assignee -> Set<id>
  }

  _index(map, key, id) {
    if (key === undefined || key === null) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(id);
  }

  _unindex(map, key, id) {
    const set = map.get(key);
    if (set) {
      set.delete(id);
      if (set.size === 0) map.delete(key);
    }
  }

  create({ title, status = 'todo', assignee = null, dueAt = null }) {
    const task = { id: this.nextId++, title, status, assignee, dueAt, createdAt: Date.now() };
    this.rows.set(task.id, task);
    this._index(this.indexByStatus, task.status, task.id);
    this._index(this.indexByAssignee, task.assignee, task.id);
    return task;
  }

  get(id) {
    return this.rows.get(id) ?? null;
  }

  /** 更新时维护二级索引;返回更新后的任务或 null */
  update(id, patch) {
    const task = this.rows.get(id);
    if (!task) return null;
    const prev = { status: task.status, assignee: task.assignee };
    if (patch.title !== undefined) task.title = patch.title;
    if (patch.dueAt !== undefined) task.dueAt = patch.dueAt;
    if (patch.status !== undefined) {
      this._unindex(this.indexByStatus, prev.status, id);
      task.status = patch.status;
      this._index(this.indexByStatus, task.status, id);
    }
    if (patch.assignee !== undefined) {
      this._unindex(this.indexByAssignee, prev.assignee, id);
      task.assignee = patch.assignee;
      this._index(this.indexByAssignee, task.assignee, id);
    }
    return task;
  }

  remove(id) {
    const task = this.rows.get(id);
    if (!task) return false;
    this.rows.delete(id);
    this._unindex(this.indexByStatus, task.status, id);
    this._unindex(this.indexByAssignee, task.assignee, id);
    return true;
  }

  /** 优先走索引,避免全表扫描 */
  list({ status, assignee, limit = 50, offset = 0 } = {}) {
    let ids;
    if (status) ids = this.indexByStatus.get(status) ?? new Set();
    else if (assignee) ids = this.indexByAssignee.get(assignee) ?? new Set();
    else ids = this.rows.keys();
    const all = [...ids].map((id) => this.rows.get(id));
    all.sort((a, b) => a.id - b.id);
    return { total: all.length, items: all.slice(offset, offset + limit) };
  }

  count() {
    return this.rows.size;
  }
}

module.exports = { TaskStore };
