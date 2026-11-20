"""Run the real Copier consumer against supported and unsupported hosts."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[1]

class Packaging(unittest.TestCase):
    def copy(self, project, *options):
        return subprocess.run(['uvx', '--from', 'copier==9.19.1', 'copier', 'copy',
            '--trust', '--defaults', '--vcs-ref', 'HEAD', *options, str(ROOT), str(project)],
            capture_output=True, text=True, timeout=120)

    def setUp(self):
        if not shutil.which('uvx'):
            self.skipTest('uvx is required for the pinned Copier consumer')

    def test_installs_only_owned_slots_and_preserves_project_files(self):
        with tempfile.TemporaryDirectory(prefix='biz-install-') as temporary:
            project = Path(temporary)
            api = project / 'framework/panel/extension-api.json'
            api.parent.mkdir(parents=True)
            api.write_text('{"version":4}\n')
            (project / '.copier-answers.yml').write_text('port_base: 6100\n')
            (project / 'README.md').write_text('Project-owned documentation\n')
            result = self.copy(project)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((project / 'README.md').read_text(), 'Project-owned documentation\n')
            self.assertTrue((project / 'extensions/biz/panel/main.js').is_file())
            self.assertTrue((project / 'extensions/biz/pages/overview.yaml').is_file())
            self.assertTrue((project / 'extensions/biz/bot.cjs').is_file())
            self.assertTrue((project / 'extensions/biz/process.yaml').is_file())
            for name in ('authorize.caddy', 'panel-access.caddy', 'mcp-authorize'):
                self.assertFalse((project / 'extensions/biz' / name).exists(), name)
            self.assertIn('biz.{$FYSO_WEB_DOMAIN}', (project / 'extensions/biz/Caddyfile').read_text())
            self.assertIn('FYSO_EXT_BIZ_PORT = "6110"', (project / '.config/mise/conf.d/ext-biz.toml').read_text())
            self.assertFalse((project / 'extensions/biz/tinyauth.providers.yaml').exists())
            env = tomllib.loads((project / '.config/mise/conf.d/ext-biz.toml').read_text())['env']
            self.assertNotIn('FYSO_WEB_SCHEME', env)
            mcp = json.loads((project / 'extensions/biz/mcp.json').read_text())
            # Bots reach Biz through the local allow-list proxy; no credential in .mcp.json.
            self.assertEqual(mcp['mcpServers']['fyso-biz'], {'type': 'stdio', 'command': 'framework/scripts/run-ext.sh',
                             'args': ['biz', '--', 'node', 'extensions/biz/mcp-proxy.cjs']})
            self.assertTrue((project / 'extensions/biz/mcp-proxy.cjs').is_file())
            for name in ['tests', 'scripts', 'panel-src', 'docs', 'artifacts', '.data', 'mise.toml', 'package.json']:
                self.assertFalse((project / name).exists(), name)

    def test_installs_policy_slots_only_for_managed_access(self):
        data = ('--data', 'biz_access_organization=fixture', '--data',
                'biz_access_project=b9209a13-a003-48f9-abc7-65f98e25b856')
        with tempfile.TemporaryDirectory(prefix='biz-managed-') as temporary:
            project = Path(temporary)
            api = project / 'framework/panel/extension-api.json'
            api.parent.mkdir(parents=True)
            api.write_text('{"version":4}\n')
            (project / '.copier-answers.yml').write_text('port_base: 6100\n')
            denied = self.copy(project, *data)
            self.assertNotEqual(denied.returncode, 0)
            self.assertIn('Update the framework', denied.stderr)
            self.assertFalse((project / 'extensions').exists())
            (api.parent / 'access-api.json').write_text('{"version":1}\n')
            result = self.copy(project, *data)
            self.assertEqual(result.returncode, 0, result.stderr)
            for name in ('authorize.caddy', 'panel-access.caddy', 'mcp-authorize'):
                self.assertTrue((project / 'extensions/biz' / name).is_file(), name)

    def test_panel_publication_uses_the_existing_biz_installation(self):
        with tempfile.TemporaryDirectory(prefix='biz-publish-') as temporary:
            project = Path(temporary)
            api = project / 'framework/panel/extension-api.json'
            api.parent.mkdir(parents=True)
            api.write_text('{"version":4}\n')
            (project / '.copier-answers.yml').write_text('port_base: 6100\n')
            result = self.copy(project, '-d', 'panel_publication=true',
                '-d', 'publication_service=https://publish.example.com',
                '-d', 'biz_sso_client_id=fixture', '-d', 'biz_sso_email=fixture@example.com')
            self.assertEqual(result.returncode, 0, result.stderr)
            answers = sorted(p.name for p in project.glob('.copier-answers.ext-*.yml'))
            self.assertEqual(answers, ['.copier-answers.ext-biz.yml'])
            self.assertTrue((project / 'extensions/biz/mcp.json').is_file())
            self.assertTrue((project / 'extensions/biz/tinyauth.providers.yaml').is_file())
            self.assertFalse((project / 'service').exists())
            config = tomllib.loads((project / '.config/mise/conf.d/ext-biz.toml').read_text())
            self.assertEqual(config['env']['FYSO_WEB_SCHEME'], 'https')
            self.assertIn('biz:status', config['tasks'])
            self.assertIn('biz:publication:status', config['tasks'])

    def test_refuses_an_unsupported_host_before_writing_slots(self):
        with tempfile.TemporaryDirectory(prefix='biz-old-host-') as temporary:
            project = Path(temporary)
            result = self.copy(project)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((project / 'extensions').exists())
            self.assertFalse((project / '.copier-answers.ext-biz.yml').exists())

    def test_refuses_an_incompatible_api_version(self):
        with tempfile.TemporaryDirectory(prefix='biz-future-host-') as temporary:
            project = Path(temporary)
            api = project / 'framework/panel/extension-api.json'
            api.parent.mkdir(parents=True)
            api.write_text('{"version":3}\n')
            (project / '.copier-answers.yml').write_text('port_base: 6100\n')
            result = self.copy(project)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((project / 'extensions').exists())

    def test_native_tagged_upgrade_preserves_the_host(self):
        with tempfile.TemporaryDirectory(prefix='biz-upgrade-') as temporary:
            base = Path(temporary)
            source = base / 'source'
            shutil.copytree(ROOT, source, ignore=shutil.ignore_patterns('.git', '.data', '__pycache__', 'node_modules'))
            project = base / 'project'
            api = project / 'framework/panel/extension-api.json'
            api.parent.mkdir(parents=True)
            api.write_text('{"version":4}\n')
            (project / '.copier-answers.yml').write_text('port_base: 6100\n')
            def run(args, cwd):
                result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=120)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            def commit(directory):
                run(['git', 'add', '.'], directory)
                run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], directory)
            run(['git', 'init', '-q'], source)
            commit(source)
            run(['git', 'tag', 'v0.1.0'], source)
            copier = ['uvx', '--from', 'copier==9.19.1', 'copier']
            run(copier + ['copy', '--trust', '--defaults', '--vcs-ref', 'v0.1.0', str(source), str(project)], base)
            run(['git', 'init', '-q'], project)
            commit(project)
            entry = source / 'extensions/biz/panel/index.html'
            updated = entry.read_text() + '<!-- release fixture -->\n'
            entry.write_text(updated)
            commit(source)
            run(['git', 'tag', 'v0.1.1'], source)
            run(copier + ['update', '--trust', '--defaults', '--answers-file', '.copier-answers.ext-biz.yml', '--vcs-ref', 'v0.1.1'], project)
            self.assertEqual((project / 'extensions/biz/panel/index.html').read_text(), updated)
            self.assertEqual(json.loads(api.read_text())["version"], 4)

if __name__ == '__main__':
    unittest.main()
