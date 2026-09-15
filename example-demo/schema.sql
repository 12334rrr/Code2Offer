-- 演示用 schema:若把内存存储替换为 SQLite/PG,表结构如下
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'todo',
  assignee VARCHAR(64),
  due_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_assignee ON tasks(assignee);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  actor VARCHAR(64),
  action VARCHAR(32),
  task_id INTEGER,
  at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
