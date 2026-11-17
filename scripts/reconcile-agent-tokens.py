#!/usr/bin/env python3
"""Reconcile only this synthetic run's response IDs against gateway raw usage."""
import argparse
import csv
import json
from pathlib import Path
import shlex
import statistics
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('reports', nargs='+', type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--usage-supplement', type=Path)
args = parser.parse_args()
reports = [json.loads(path.read_text()) for path in args.reports]
assert all(report.get('finishedAt') for report in reports), 'Wait for each benchmark to finish'
ids = sorted({request['responseId'].removeprefix('chatcmpl-')
              for report in reports for request in report['apiRequests'] if request.get('responseId')})
remote = r'''
import json, sqlite3, sys
ids=json.loads(sys.stdin.read())
connection=sqlite3.connect('file:/app/9router/data/db/data.sqlite?mode=ro',uri=True)
query="SELECT id,json_extract(data,'$.providerResponse.response.responseId'),json_extract(data,'$.providerResponse.response.usageMetadata'),json_extract(data,'$.providerResponse.response.candidates[0].content.parts') FROM requestDetails WHERE json_extract(data,'$.providerResponse.response.responseId') IN ("+','.join('?' for _ in ids)+')'
result={}
for record_id,response_id,raw,parts in connection.execute(query,ids):
 if raw:
  result[response_id]={'recordId':record_id,'usageMetadata':json.loads(raw)}
  if parts:result[response_id]['syntheticReply']=''.join(part.get('text','') for part in json.loads(parts) if not part.get('thought'))
print(json.dumps(result))
'''
retrieved = subprocess.run(['ssh', 'root@103.173.227.247', 'python3 -c ' + shlex.quote(remote)],
                           input=json.dumps(ids), text=True, capture_output=True, check=True)
raw_usage = json.loads(retrieved.stdout)
if args.usage_supplement:
    supplement = json.loads(args.usage_supplement.read_text())
    assert not set(supplement).intersection(raw_usage), 'Do not replace raw response-ID evidence'
    assert set(supplement).issubset(ids), 'Supplement contains an unrelated response'
    raw_usage.update(supplement)


def tokens(requests):
    result = {'input': 0, 'visibleOutput': 0, 'reasoning': 0, 'total': 0,
              'cachedInput': 0, 'gatewayReportedTotal': 0, 'gatewayBuffer': 0,
              'apiRequests': len(requests), 'verifiedRequests': 0, 'unverifiedRequests': 0,
              'usageHistoryMatches': 0}
    for request in requests:
        usage = request.get('usage') or {}
        result['gatewayReportedTotal'] += usage.get('total_tokens', 0)
        raw = raw_usage.get(request.get('responseId', '').removeprefix('chatcmpl-'))
        if not raw:
            result['unverifiedRequests'] += 1
            continue
        provider = raw['usageMetadata']
        result['verifiedRequests'] += 1
        result['usageHistoryMatches'] += int(raw.get('source') == 'usageHistory')
        for target, source in [('input', 'promptTokenCount'), ('visibleOutput', 'candidatesTokenCount'),
                               ('reasoning', 'thoughtsTokenCount'), ('total', 'totalTokenCount'),
                               ('cachedInput', 'cachedContentTokenCount')]:
            result[target] += provider.get(source, 0)
        result['gatewayBuffer'] += usage.get('total_tokens', 0) - provider.get('totalTokenCount', 0)
    result['outputIncludingReasoning'] = result['visibleOutput'] + result['reasoning']
    return result


analysis = {'source': '9Router VPS 103 raw provider usage matched by response ID; supplemental usageHistory counters retain their separate provenance',
            'scope': 'Current agent planner/review with fixed synthetic data and synthetic tool preparation; no execution or patient database access',
            'pricing': 'No monetary estimate; token counts are not an invoice',
            'reports': [], 'rawUsageByResponseId': raw_usage}
csv_rows = []
for filename, report in zip(args.reports, reports):
    rows = []
    for row in report['rows']:
        requests = [request for request in report['apiRequests'] if request['case'] == row['id']]
        entry = {**{key: row.get(key) for key in ('id', 'group', 'text', 'passed', 'negative', 'resultStatus', 'error', 'message', 'ms')},
                 'tokens': tokens(requests)}
        rows.append(entry)
        csv_rows.append({'report': filename.name, **{key: entry[key] for key in ('id', 'group', 'text', 'passed', 'negative', 'resultStatus', 'ms')},
                         **entry['tokens']})
    groups = {}
    for group in sorted({row['group'] for row in rows}):
        own = [row for row in rows if row['group'] == group]
        requests = [request for request in report['apiRequests'] if request['case'] in {row['id'] for row in own}]
        groups[group] = {'cases': len(own), 'passed': sum(row['passed'] for row in own), 'tokens': tokens(requests)}
    nonzero = [row['tokens']['total'] for row in rows if row['tokens']['apiRequests']]
    passed_nonzero = [row['tokens']['total'] for row in rows if row['passed'] and row['tokens']['apiRequests']]
    started_at = report.get('startedAt') or min(request['startedAt'] for request in report['apiRequests'])
    analyzed = {'file': str(filename.resolve()), 'startedAt': started_at, 'finishedAt': report['finishedAt'],
                'cases': len(rows), 'passed': sum(row['passed'] for row in rows),
                'failed': sum(not row['passed'] for row in rows),
                'negativeCases': sum(row['negative'] for row in rows),
                'negativePassed': sum(row['negative'] and row['passed'] for row in rows),
                'zeroTokenCases': [row['id'] for row in rows if not row['tokens']['apiRequests']],
                'tokens': tokens(report['apiRequests']), 'groups': groups, 'rows': rows,
                'averagePerCase': round(sum(row['tokens']['total'] for row in rows) / len(rows), 2),
                'withAi': {'average': round(statistics.mean(nonzero), 2), 'median': statistics.median(nonzero),
                           'min': min(nonzero), 'max': max(nonzero)},
                'passedWithAiAverage': round(statistics.mean(passed_nonzero), 2) if passed_nonzero else None}
    analysis['reports'].append(analyzed)
analysis['wholeMeasurement'] = tokens([request for report in reports for request in report['apiRequests']])
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(analysis, ensure_ascii=False, indent=2) + '\n')
args.output.chmod(0o600)
csv_path = args.output.with_suffix('.csv')
with csv_path.open('w', encoding='utf-8-sig', newline='') as output:
    writer = csv.DictWriter(output, fieldnames=list(csv_rows[0]))
    writer.writeheader()
    writer.writerows(csv_rows)
csv_path.chmod(0o600)
print(json.dumps({'analysis': str(args.output.resolve()), 'csv': str(csv_path.resolve()),
                  'reports': [{key: value for key, value in report.items() if key not in ('rows', 'groups')}
                              for report in analysis['reports']],
                  'wholeMeasurement': analysis['wholeMeasurement']}, ensure_ascii=False))
