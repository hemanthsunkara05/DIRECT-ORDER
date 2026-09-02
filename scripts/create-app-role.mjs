import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set. Run the $env:DATABASE_URL="..." line first.');
  process.exit(1);
}
const appRolePassword = process.env.APP_ROLE_PASSWORD;
if (!appRolePassword) {
  console.error('APP_ROLE_PASSWORD not set. Run the $env:APP_ROLE_PASSWORD="..." line first.');
  process.exit(1);
}
const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const escapedPassword = appRolePassword.replace(/'/g, "''");
  await c.query(`CREATE ROLE direct_order_app WITH LOGIN PASSWORD '${escapedPassword}'`);
  console.log('role created');
} catch (e) {
  if (e.code === '42710') console.log('role already exists — ok, continue');
  else { console.error('failed:', e.message); process.exit(1); }
} finally {
  await c.end();
}
