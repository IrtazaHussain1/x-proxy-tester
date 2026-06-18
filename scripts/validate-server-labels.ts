import 'dotenv/config';
import { prisma } from '../src/lib/db';
import { computeServerLabelFromDeviceName } from '../src/helpers/server-name';

const SQL = `
SELECT name,
  CASE
    WHEN UPPER(TRIM(name)) REGEXP 'S[0-9]{1,3}[[:space:]_-]*P[0-9]+'
      THEN REGEXP_SUBSTR(REGEXP_SUBSTR(UPPER(TRIM(name)), 'S[0-9]{1,3}[[:space:]_-]*P[0-9]+'), 'S[0-9]{1,3}')
    WHEN UPPER(TRIM(name)) REGEXP '^S[0-9]{1,3}[[:space:]_-]+[0-9]+'
      THEN REGEXP_SUBSTR(UPPER(TRIM(name)), '^S[0-9]{1,3}')
    ELSE 'Unknown'
  END AS sql_label
FROM proxies
`;

async function main(): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<{ name: string | null; sql_label: string }[]>(SQL);
  let total = 0;
  let unknown = 0;
  const labels = new Map<string, number>();
  const mismatches: { name: string | null; ts: string; sql: string }[] = [];
  const salvageable: string[] = [];

  for (const r of rows) {
    total++;
    const tsRaw = computeServerLabelFromDeviceName(r.name);
    const ts = tsRaw === 'UNKNOWN' ? 'Unknown' : tsRaw;
    const sql = r.sql_label || 'Unknown';
    labels.set(ts, (labels.get(ts) ?? 0) + 1);
    if (ts === 'Unknown') unknown++;
    if (ts !== sql) mismatches.push({ name: r.name, ts, sql });
    if (
      ts === 'Unknown' &&
      r.name &&
      (/S\d{1,3}[\s_-]*P\d+/i.test(r.name) || /^S\d{1,3}[\s_-]+\d+/i.test(r.name))
    ) {
      salvageable.push(r.name);
    }
  }

  const sortedLabels = [...labels.entries()].sort((a, b) => {
    const na = a[0] === 'Unknown' ? 1e9 : Number.parseInt(a[0].slice(1), 10);
    const nb = b[0] === 'Unknown' ? 1e9 : Number.parseInt(b[0].slice(1), 10);
    return na - nb;
  });

  console.log(`total=${total} unknown=${unknown} TSvsSQL_mismatches=${mismatches.length} salvageable_unknown=${salvageable.length}`);
  console.log('\nTS vs SQL mismatches:', mismatches.length ? mismatches.slice(0, 50) : 'NONE');
  console.log('\nUnknown-but-looks-like-rack:', salvageable.length ? salvageable.slice(0, 50) : 'NONE');
  console.log('\nLabel distribution:');
  console.log(sortedLabels.map(([k, v]) => `${k}:${v}`).join('  '));

  await prisma.$disconnect();
}

void main();
