import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path('/home/ubuntu/CleanURLs-Copy-MV3')
CLEAR_URLS_SOURCE = ROOT / 'vendor' / 'clearurls_data.minify.json'
ADGUARD_SOURCE = ROOT / 'vendor' / 'adguard_url_tracking_filter.txt'
UBLOCK_SOURCE = ROOT / 'vendor' / 'ublock_privacy.txt'
TARGET = ROOT / 'rules.js'
STATS_TARGET = ROOT / 'vendor' / 'rules_conversion_stats.json'

EXACT_PARAM = re.compile(r'^[A-Za-z0-9_%.-]{1,120}$')
HOST_ONLY = re.compile(r'^\|\|([A-Za-z0-9.-]+)\^$')
REGEX_PARAM = re.compile(r'^/(.{1,240})/$')


def clean_provider(provider):
    allowed = ('urlPattern', 'rules', 'rawRules', 'redirections', 'exceptions', 'referralMarketing', 'completeProvider')
    return {key: provider[key] for key in allowed if key in provider}


def classify_param(value):
    value = value.strip()
    if not value or value == '*':
        return None
    match = REGEX_PARAM.fullmatch(value)
    if match:
        pattern = match.group(1)
        # Keep only bounded, ordinary regexes. Skip lookarounds/backreferences and very complex forms.
        if len(pattern) <= 240 and not re.search(r'\\[1-9]|\(\?[=!<]|\{\d+,\d{4,}\}', pattern):
            try:
                re.compile(pattern, re.I)
                return ('pattern', pattern)
            except re.error:
                return None
    if EXACT_PARAM.fullmatch(value):
        return ('literal', value)
    return None


def parse_domain_modifier(parts):
    domains = []
    for part in parts:
        if not part.startswith('domain='):
            continue
        for domain in part[len('domain='):].split('|'):
            domain = domain.strip()
            if domain and not domain.startswith('~') and re.fullmatch(r'[A-Za-z0-9.-]+', domain):
                domains.append(domain.lower())
    return sorted(set(domains))


def parse_filter(text):
    global_literals = set()
    global_patterns = set()
    site_rules = defaultdict(lambda: {'literals': set(), 'patterns': set()})
    stats = {
        'total_lines': 0,
        'removeparam_lines': 0,
        'accepted_global_literals': 0,
        'accepted_global_patterns': 0,
        'accepted_site_literals': 0,
        'accepted_site_patterns': 0,
        'skipped_unsupported': 0,
    }

    for raw_line in text.splitlines():
        stats['total_lines'] += 1
        line = raw_line.strip()
        if not line or line.startswith(('!', '[', '#')) or '$removeparam' not in line:
            continue
        stats['removeparam_lines'] += 1
        prefix, suffix = line.split('$removeparam', 1)
        suffix_parts = suffix.split(',')
        value = suffix_parts[0].lstrip('=').strip()
        classified = classify_param(value)
        if not classified:
            stats['skipped_unsupported'] += 1
            continue

        kind, normalized = classified
        domain_hosts = []
        host_match = HOST_ONLY.fullmatch(prefix.strip())
        if host_match:
            domain_hosts = [host_match.group(1).lower()]
        else:
            domain_hosts = parse_domain_modifier(suffix_parts[1:])

        # Rules with path/query conditions but no explicit domain are not safe to generalize.
        if prefix.strip() and not domain_hosts:
            stats['skipped_unsupported'] += 1
            continue

        if not domain_hosts:
            (global_literals if kind == 'literal' else global_patterns).add(normalized)
            stats['accepted_global_literals' if kind == 'literal' else 'accepted_global_patterns'] += 1
        else:
            for host in domain_hosts:
                site_rules[host]['literals' if kind == 'literal' else 'patterns'].add(normalized)
                stats['accepted_site_literals' if kind == 'literal' else 'accepted_site_patterns'] += 1

    return {
        'globalLiterals': sorted(global_literals, key=str.lower),
        'globalPatterns': sorted(global_patterns),
        'siteRules': [
            {
                'host': host,
                'literals': sorted(values['literals'], key=str.lower),
                'patterns': sorted(values['patterns'])
            }
            for host, values in sorted(site_rules.items())
            if values['literals'] or values['patterns']
        ]
    }, stats


def merge_rule_sets(first, second):
    merged = {
        'globalLiterals': sorted(set(first['globalLiterals']) | set(second['globalLiterals']), key=str.lower),
        'globalPatterns': sorted(set(first['globalPatterns']) | set(second['globalPatterns'])),
        'siteRules': []
    }
    by_host = {}
    for source in (first, second):
        for site in source['siteRules']:
            entry = by_host.setdefault(site['host'], {'host': site['host'], 'literals': set(), 'patterns': set()})
            entry['literals'].update(site['literals'])
            entry['patterns'].update(site['patterns'])
    merged['siteRules'] = [
        {
            'host': host,
            'literals': sorted(entry['literals'], key=str.lower),
            'patterns': sorted(entry['patterns'])
        }
        for host, entry in sorted(by_host.items())
        if entry['literals'] or entry['patterns']
    ]
    return merged


clear_data = json.loads(CLEAR_URLS_SOURCE.read_text())
providers = {name: clean_provider(provider) for name, provider in clear_data.get('providers', {}).items()}
adguard_data, adguard_stats = parse_filter(ADGUARD_SOURCE.read_text())
ublock_data, ublock_stats = parse_filter(UBLOCK_SOURCE.read_text())
merged_data = merge_rule_sets(adguard_data, ublock_data)

bundled = {
    'providers': providers,
    'adguard': merged_data,
    'sourceMetadata': {
        'clearurls': 'https://rules1.clearurls.xyz/data.minify.json',
        'adguard': 'https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_17_TrackParam/filter.txt',
        'ublock': 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt',
        'ublockSyntaxReference': 'https://github.com/gorhill/uBlock/wiki/Static-filter-syntax',
        'conversionPolicy': 'Only bounded literal/regex removeparam rules and explicit host rules are imported; unsupported path, redirect, remove-all and complex modifier rules are skipped.'
    }
}

TARGET.write_text(
    '/* Generated offline rules. Sources and conversion policy are in sourceMetadata. */\n'
    + 'globalThis.CLEAN_URLS_RULES = '
    + json.dumps(bundled, ensure_ascii=False, separators=(',', ':'))
    + ';\n'
)

stats = {
    'clearurls_providers': len(providers),
    'merged_global_literals': len(merged_data['globalLiterals']),
    'merged_global_patterns': len(merged_data['globalPatterns']),
    'merged_site_rules': len(merged_data['siteRules']),
    'adguard_global_literals': len(adguard_data['globalLiterals']),
    'ublock_global_literals': len(ublock_data['globalLiterals']),
    'adguard': adguard_stats,
    'ublock': ublock_stats,
}
STATS_TARGET.write_text(json.dumps(stats, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({**stats, 'target_bytes': TARGET.stat().st_size}, ensure_ascii=False, indent=2))
