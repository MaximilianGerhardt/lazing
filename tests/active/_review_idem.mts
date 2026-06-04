const { getDb } = await import('@/db/client');
const db1:any = getDb();
// force re-run of migrations against same file by re-importing fresh is hard; instead exec the migration SQL twice directly
import { readFileSync } from 'node:fs';
const sqlText = readFileSync('db/migrations/0125_subchat_read_markers.sql','utf8');
try { db1.$raw.exec(sqlText); db1.$raw.exec(sqlText); console.log('RESULT idem_double_exec: OK'); }
catch(e:any){ console.log('RESULT idem_double_exec: THREW', e.message); }
// confirm events table column types are TEXT (new union members are plain strings)
const cols:any = db1.$raw.prepare("SELECT name,type FROM pragma_table_info('events') WHERE name IN ('event_type','entity_type')").all();
console.log('RESULT event_cols:', JSON.stringify(cols));
