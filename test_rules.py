import importlib.util
import json
import re
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import build_copy_rules as rules


class ConverterTests(unittest.TestCase):
    def test_import_safe_and_root_relative(self):
        spec = importlib.util.spec_from_file_location('isolated_rules', rules.ROOT / 'build_copy_rules.py')
        module = importlib.util.module_from_spec(spec)
        with patch.object(Path, 'read_text', side_effect=AssertionError('import reads data')), patch.object(Path, 'write_text', side_effect=AssertionError('import writes data')):
            spec.loader.exec_module(module)
        self.assertEqual(module.ROOT, Path(rules.__file__).resolve().parent)
        result = subprocess.run([sys.executable, '-B', '-c',
                                 f"import sys; sys.path.insert(0, {str(rules.ROOT)!r}); import build_copy_rules"],
                                cwd=rules.ROOT.parent, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '')

    def test_literals_host_and_positive_target(self):
        data, stats = rules.parse_filter('$removeparam=fbclid\n||example.com^$removeparam=track\n$removeparam=campaign,to=one.test|two.test')
        self.assertEqual(data['globalLiterals'], ['fbclid'])
        self.assertEqual({site['host']: site['literals'] for site in data['siteRules']},
                         {'example.com': ['track'], 'one.test': ['campaign'], 'two.test': ['campaign']})
        self.assertEqual(stats['accepted_site_literals'], 3)
        self.assertEqual(stats['skipped_unsupported'], 0)

    def test_target_intersection_never_widens(self):
        for prefix, target, host in [('example.com', 'sub.example.com', 'sub.example.com'),
                                     ('sub.example.com', 'example.com', 'sub.example.com')]:
            data, _ = rules.parse_filter(f'||{prefix}^$removeparam=track,to={target}')
            self.assertEqual(data['siteRules'][0]['host'], host)
        data, stats = rules.parse_filter('||example.com^$removeparam=track,to=other.test')
        self.assertEqual(data['siteRules'], [])
        self.assertEqual(stats['skipped_reasons'], {'empty_target_intersection': 1})

    def test_unsupported_scopes_are_never_globalized(self):
        cases = {
            '$removeparam=x,domain=example.com': 'initiator_scope',
            '$removeparam=x,domain=~example.com': 'initiator_scope',
            '||target.test^$removeparam=x,domain=initiator.test': 'initiator_scope',
            '$removeparam=x,from=example.com': 'initiator_scope',
            '||example.com/path$removeparam=x,domain=example.com': 'initiator_scope',
            '$removeparam=x,to=~example.com': 'unsupported_target',
            '$removeparam=x,to=example.*': 'unsupported_target',
            '$removeparam=x,to=': 'unsupported_target',
            '$removeparam=x,document': 'unsupported_modifier',
            '$removeparam=x,third-party': 'unsupported_modifier',
            '$removeparam=x,unknown': 'unsupported_modifier',
            '$script,removeparam=x': 'unsupported_modifier',
            '||example.com/path$removeparam=x,to=example.com': 'path_or_url_scope',
            '/path$removeparam=x': 'path_or_url_scope',
            '$removeparam': 'unsupported_parameter',
            '$removeparam=~keep': 'unsupported_parameter',
        }
        for source, reason in cases.items():
            with self.subTest(source=source):
                data, stats = rules.parse_filter(source)
                self.assertEqual(data['globalLiterals'], [])
                self.assertEqual(data['globalPatterns'], [])
                self.assertEqual(data['siteRules'], [])
                self.assertEqual(stats['skipped_reasons'], {reason: 1})

    def test_regex_commas_and_value_specific_rules(self):
        data, stats = rules.parse_filter(r'||example.com^$removeparam=/^track=a{1\,3}$/')
        self.assertEqual(data['siteRules'][0]['patterns'], ['^track=a{1,3}$'])
        self.assertEqual(stats['skipped_unsupported'], 0)
        data, _ = rules.parse_filter(r'||example.com^$removeparam=/^track=drop$/,to=example.com')
        self.assertEqual(data['siteRules'][0]['patterns'], ['^track=drop$'])
        for param in ('*', '', '~/keep/', '/(?=track)/', r'/(a)\1/', '/[/'):
            self.assertIsNone(rules.classify_param(param))

    def test_exception_modifier_order_and_unsupported_context(self):
        data, stats = rules.parse_filter('$removeparam=fbclid\n@@||example.com/path$script,removeparam=fbclid,domain=initiator.test')
        exception = data['exceptions'][0]
        self.assertEqual(exception['literals'], ['fbclid'])
        self.assertRegex('https://sub.example.com/other?fbclid=x', exception['urlPattern'])
        self.assertNotRegex('https://example.com.evil.test/?fbclid=x', exception['urlPattern'])
        self.assertEqual(stats['broadened_exceptions'], 1)
        self.assertEqual(stats['skipped_reasons']['exception_scope_broadened'], 1)

    def test_curated_wildcard_exceptions_do_not_become_global_vetoes(self):
        for host, path, parameter in [('google', '/maps^', 'utm_campaign'),
                                      ('uploadnow', '/share', 'utm_source')]:
            data, _ = rules.parse_filter(f'@@||{host}.*{path}$removeparam={parameter}')
            exception = data['exceptions'][0]
            self.assertNotEqual(exception['urlPattern'], '.*')
            self.assertNotRegex('https://example.com/?utm_source=news', exception['urlPattern'])
            self.assertNotRegex('https://127.0.0.1/', exception['urlPattern'])
            for suffix in ('com', 'co.uk'):
                self.assertRegex(f'https://{host}.{suffix}/anywhere', exception['urlPattern'])
                self.assertRegex(f'https://sub.{host}.{suffix}/anywhere', exception['urlPattern'])
                self.assertNotRegex(f'https://not{host}.{suffix}/', exception['urlPattern'])

    def test_initiator_exception_retains_source_metadata(self):
        for modifier in ('domain', 'from'):
            data, stats = rules.parse_filter(f'@@$removeparam=utm_source,{modifier}=Hobbygames.ru|shop.test|~private.hobbygames.ru')
            self.assertEqual(data['exceptions'], [{'urlPattern': '.*', 'literals': ['utm_source'],
                                                  'initiator': {'include': ['hobbygames.ru', 'shop.test'],
                                                                'exclude': ['private.hobbygames.ru']}}])
            self.assertEqual(stats['broadened_exceptions'], 0)

    def test_negative_and_unsupported_initiator_exceptions(self):
        data, _ = rules.parse_filter('@@$removeparam=utm_source,from=~hobbygames.ru')
        self.assertEqual(data['exceptions'][0]['initiator'], {'include': [], 'exclude': ['hobbygames.ru']})
        for value in ('', 'google.*', '~google.*', 'hobbygames.ru|', '/example/', 'hobbygames.ru|~google.*'):
            data, stats = rules.parse_filter(f'@@$removeparam=utm_source,domain={value}')
            self.assertTrue(data['exceptions'][0]['initiator']['unsupported'])
            self.assertEqual(stats['broadened_exceptions'], 1)
        data, _ = rules.parse_filter('@@$removeparam=utm_source,domain=one.test,from=two.test')
        self.assertTrue(data['exceptions'][0]['initiator']['unsupported'])

    def test_unknown_exception_parameter_disables_all_removals(self):
        for suffix in ('removeparam', 'removeparam=~keep', 'removeparam=/(?=unsafe)/'):
            data, _ = rules.parse_filter('@@||example.com^$' + suffix)
            self.assertTrue(data['exceptions'][0]['all'])
        data, _ = rules.parse_filter('@@||example.*/path$removeparam=x')
        self.assertRegex('https://example.com/other', data['exceptions'][0]['urlPattern'])
        self.assertNotRegex('https://other.test/path', data['exceptions'][0]['urlPattern'])

    def test_merge_keeps_cross_source_vetoes(self):
        first, _ = rules.parse_filter('$removeparam=fbclid\n||example.com^$removeparam=one')
        second, _ = rules.parse_filter('@@$removeparam=fbclid,domain=initiator.test\n||example.com^$removeparam=two')
        merged = rules.merge_rule_sets(first, second)
        self.assertEqual(merged['exceptions'], second['exceptions'])
        self.assertEqual(merged['siteRules'][0]['literals'], ['one', 'two'])

    def test_vendored_conversion_retains_every_removeparam_exception(self):
        for source in (rules.ADGUARD_SOURCE, rules.UBLOCK_SOURCE):
            text = source.read_text(encoding='utf-8')
            data, stats = rules.parse_filter(text)
            expected = sum(line.startswith('@@') and re.search(r'(?:\$|,)removeparam(?:=|,|$)', line) is not None
                           for line in text.splitlines())
            self.assertEqual(len(data['exceptions']), expected)
            self.assertEqual(stats['accepted_exceptions'], expected)
            self.assertGreater(stats['skipped_unsupported'], 0)

    def test_shipped_rules_match_current_conversion(self):
        payload = rules.TARGET.read_text(encoding='utf-8').split('globalThis.CLEAN_URLS_RULES = ', 1)[1].strip().removesuffix(';')
        shipped = json.loads(payload)
        first, _ = rules.parse_filter(rules.ADGUARD_SOURCE.read_text(encoding='utf-8'))
        second, _ = rules.parse_filter(rules.UBLOCK_SOURCE.read_text(encoding='utf-8'))
        expected = rules.merge_rule_sets(first, second)
        self.assertTrue(shipped['adguard'].get('exceptions'), 'Parent must rebuild rules.js with build_copy_rules.py')
        self.assertEqual(shipped['adguard'], expected, 'rules.js is stale; parent must rebuild')


if __name__ == '__main__':
    unittest.main()
