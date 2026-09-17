import json
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CLEAR_URLS_SOURCE = ROOT / 'vendor' / 'clearurls_data.minify.json'
ADGUARD_SOURCE = ROOT / 'vendor' / 'adguard_url_tracking_filter.txt'
UBLOCK_SOURCE = ROOT / 'vendor' / 'ublock_privacy.txt'
TARGET = ROOT / 'rules.js'
STATS_TARGET = ROOT / 'vendor' / 'rules_conversion_stats.json'

EXACT_PARAM = re.compile(r'^[A-Za-z0-9_%.-]{1,120}$')
HOST = r'[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*'
HOST_ONLY = re.compile(r'^\|\|(' + HOST + r')\^$')
REGEX_PARAM = re.compile(r'^/(.{1,240})/$')


def clean_provider(provider):
    allowed = ('urlPattern', 'rules', 'rawRules', 'redirections', 'exceptions', 'referralMarketing', 'completeProvider')
    return {key: provider[key] for key in allowed if key in provider}


def classify_param(value):
    value = value.strip()
    match = REGEX_PARAM.fullmatch(value)
    if match:
        pattern = match.group(1).replace(r'\,', ',')
        if not re.search(r'\\[1-9]|\(\?|\{\d+,\d{4,}\}|\\[aAzZNpPuU]|\[[^\]]*&&', pattern):
            try:
                re.compile(pattern)
                return ('pattern', pattern)
            except re.error:
                pass
        return None
    if EXACT_PARAM.fullmatch(value):
        return ('literal', value)
    return None


def split_modifiers(value):
    parts = []
    start = 0
    escaped = False
    in_regex = False
    for index, char in enumerate(value):
        if escaped:
            escaped = False
            continue
        if char == '\\':
            escaped = True
        elif char == '/' and (in_regex or value[start:index].endswith('removeparam=')):
            in_regex = not in_regex
        elif char == ',' and not in_regex:
            parts.append(value[start:index])
            start = index + 1
    parts.append(value[start:])
    return parts


def exception_pattern(prefix):
    if prefix in ('', '*'):
        return '.*'
    host = re.match(r'^\|\|(' + HOST + r')(?=[/^])', prefix)
    if host:
        return r'^https?://(?:[^/]+\.)?' + re.escape(host.group(1)) + r'(?=[:/]|$)'
    wildcard_host = re.match(r'^\|\|(' + HOST + r')\.\*(?=[/^])', prefix)
    if wildcard_host:
        return r'^https?://(?:[^/]+\.)?' + re.escape(wildcard_host.group(1)) + r'\.[^/:]+(?=[:/]|$)'
    if prefix.startswith('||'):
        return '.*'
    if prefix.startswith('/') and prefix.endswith('/'):
        return '.*'
    pattern = re.escape(prefix.strip('|')).replace(r'\*', '.*').replace(r'\^', r'(?:[^A-Za-z0-9_.%-]|$)')
    return ('^' if prefix.startswith('|') else '') + pattern


def parse_filter(text):
    global_literals = set()
    global_patterns = set()
    site_rules = defaultdict(lambda: {'literals': set(), 'patterns': set()})
    exceptions = []
    reasons = Counter()
    stats = dict.fromkeys(('total_lines', 'removeparam_lines', 'accepted_global_literals',
                          'accepted_global_patterns', 'accepted_site_literals', 'accepted_site_patterns',
                          'accepted_exceptions', 'broadened_exceptions', 'skipped_unsupported'), 0)

    for raw_line in text.splitlines():
        stats['total_lines'] += 1
        line = raw_line.strip()
        if not line or line.startswith(('!', '[', '#')) or '$' not in line:
            continue
        boundary = re.search(r'\$(?=[a-z~])', line)
        if not boundary:
            continue
        prefix = line[:boundary.start()]
        parts = split_modifiers(line[boundary.end():])
        params = [part for part in parts if part == 'removeparam' or part.startswith('removeparam=')]
        if not params:
            continue
        stats['removeparam_lines'] += 1
        value = params[0].partition('=')[2]
        classified = classify_param(value) if len(params) == 1 else None
        modifiers = [part for part in parts if part not in params]
        if prefix.startswith('@@'):
            entry = {'urlPattern': exception_pattern(prefix[2:])}
            if classified:
                kind, normalized = classified
                entry['literals' if kind == 'literal' else 'patterns'] = [normalized]
            else:
                entry['all'] = True
            initiators = [part for part in modifiers if part.startswith(('domain=', 'from='))]
            if initiators:
                scope = {'include': [], 'exclude': []}
                for modifier in initiators:
                    for domain in modifier.partition('=')[2].split('|'):
                        host = domain.removeprefix('~')
                        if re.fullmatch(HOST, host):
                            scope['exclude' if domain.startswith('~') else 'include'].append(host.lower())
                        else:
                            scope['unsupported'] = True
                if len(initiators) > 1:
                    scope['unsupported'] = True
                entry['initiator'] = scope
            exceptions.append(entry)
            stats['accepted_exceptions'] += 1
            if (any(part not in initiators for part in modifiers)
                    or entry.get('initiator', {}).get('unsupported')
                    or (prefix[2:] not in ('', '*') and not HOST_ONLY.fullmatch(prefix[2:]))
                    or not classified):
                stats['broadened_exceptions'] += 1
                reasons['exception_scope_broadened'] += 1
            continue

        reason = None
        hosts = []
        host_match = HOST_ONLY.fullmatch(prefix)
        if any(part.startswith(('domain=', 'from=')) for part in modifiers):
            reason = 'initiator_scope'
        elif any(not part.startswith('to=') for part in modifiers):
            reason = 'unsupported_modifier'
        elif len(modifiers) > 1:
            reason = 'unsupported_target'
        elif prefix not in ('', '*') and not host_match:
            reason = 'path_or_url_scope'
        elif not classified:
            reason = 'unsupported_parameter'
        else:
            hosts = [host_match.group(1).lower()] if host_match else []
            if modifiers:
                targets = modifiers[0][3:].split('|')
                if not all(re.fullmatch(HOST, target) for target in targets):
                    reason = 'unsupported_target'
                elif hosts:
                    hosts = sorted({target.lower() if target.lower().endswith('.' + hosts[0]) else hosts[0]
                                    for target in targets if target.lower() == hosts[0]
                                    or target.lower().endswith('.' + hosts[0]) or hosts[0].endswith('.' + target.lower())})
                    if not hosts:
                        reason = 'empty_target_intersection'
                else:
                    hosts = sorted({target.lower() for target in targets})
        if reason:
            stats['skipped_unsupported'] += 1
            reasons[reason] += 1
            continue
        kind, normalized = classified
        key = 'literals' if kind == 'literal' else 'patterns'
        if hosts:
            for host in hosts:
                site_rules[host][key].add(normalized)
                stats['accepted_site_' + key] += 1
        else:
            (global_literals if kind == 'literal' else global_patterns).add(normalized)
            stats['accepted_global_' + key] += 1

    stats['skipped_reasons'] = dict(sorted(reasons.items()))
    return {
        'globalLiterals': sorted(global_literals),
        'globalPatterns': sorted(global_patterns),
        'siteRules': [{'host': host, 'literals': sorted(values['literals']), 'patterns': sorted(values['patterns'])}
                      for host, values in sorted(site_rules.items())],
        'exceptions': exceptions
    }, stats


def merge_rule_sets(first, second):
    by_host = defaultdict(lambda: {'literals': set(), 'patterns': set()})
    for source in (first, second):
        for site in source['siteRules']:
            for key in ('literals', 'patterns'):
                by_host[site['host']][key].update(site[key])
    return {
        'globalLiterals': sorted(set(first['globalLiterals']) | set(second['globalLiterals'])),
        'globalPatterns': sorted(set(first['globalPatterns']) | set(second['globalPatterns'])),
        'siteRules': [{'host': host, 'literals': sorted(entry['literals']), 'patterns': sorted(entry['patterns'])}
                      for host, entry in sorted(by_host.items())],
        'exceptions': first.get('exceptions', []) + second.get('exceptions', [])
    }


def main():
    clear_data = json.loads(CLEAR_URLS_SOURCE.read_text(encoding='utf-8'))
    providers = {name: clean_provider(provider) for name, provider in clear_data.get('providers', {}).items()}
    adguard_data, adguard_stats = parse_filter(ADGUARD_SOURCE.read_text(encoding='utf-8'))
    ublock_data, ublock_stats = parse_filter(UBLOCK_SOURCE.read_text(encoding='utf-8'))
    merged_data = merge_rule_sets(adguard_data, ublock_data)
    bundled = {
        'providers': providers,
        'adguard': merged_data,
        'sourceMetadata': {
            'clearurls': 'https://rules1.clearurls.xyz/data.minify.json',
            'adguard': 'https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_17_TrackParam/filter.txt',
            'ublock': 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt',
            'ublockSyntaxReference': 'https://github.com/gorhill/uBlock/wiki/Static-filter-syntax',
            'conversionPolicy': 'Only literal/regex removeparam rules with fully retained target scopes are imported. Removal rules with initiator, path and context restrictions are skipped. Exceptions veto all rule sources, retain supported initiator domains, and are broadened when necessary; unknown initiators retain exceptions.'
        }
    }
    TARGET.write_text('globalThis.CLEAN_URLS_RULES = ' + json.dumps(bundled, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    stats = {
        'clearurls_providers': len(providers),
        'merged_global_literals': len(merged_data['globalLiterals']),
        'merged_global_patterns': len(merged_data['globalPatterns']),
        'merged_site_rules': len(merged_data['siteRules']),
        'merged_exceptions': len(merged_data['exceptions']),
        'adguard_global_literals': len(adguard_data['globalLiterals']),
        'ublock_global_literals': len(ublock_data['globalLiterals']),
        'adguard': adguard_stats,
        'ublock': ublock_stats,
    }
    STATS_TARGET.write_text(json.dumps(stats, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({**stats, 'target_bytes': TARGET.stat().st_size}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
