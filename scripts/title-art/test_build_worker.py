"""Build contexts contain licensed source, never an operator's checkpoints or credentials."""
import importlib.util
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('build_worker', Path(__file__).with_name('build-worker.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class WorkerContextTest(unittest.TestCase):
    def upstream(self, directory):
        source = directory / 'upstream'
        source.mkdir()
        def git(*args):
            return subprocess.check_output(['git', '-C', str(source), *args], text=True).strip()
        git('init', '-q')
        git('config', 'user.name', 'Local test')
        git('config', 'user.email', 'test@example.invalid')
        (source / 'LICENSE').write_text('Apache License\n')
        (source / 'source.py').write_text('# Original upstream copyright\n')
        (source / '.gitignore').write_text('*.pth\n')
        git('add', '.')
        git('commit', '-qm', 'fixture source')
        (source / 'private.pth').write_bytes(b'operator checkpoint must never enter the image')
        return source, git('rev-parse', 'HEAD')

    def test_archive_preserves_upstream_notices_without_untracked_weights(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source, revision = self.upstream(directory)
            with patch.object(builder, 'REVISION', revision):
                context = builder.prepare_context(source, directory / 'context')
            with tarfile.open(context / 'hi-sam.tar') as archive:
                self.assertIn('LICENSE', archive.getnames())
                self.assertEqual(archive.extractfile('source.py').read(), b'# Original upstream copyright\n')
                self.assertFalse(any(name.endswith('.pth') or '.git/' in name for name in archive.getnames()))
            self.assertIn('Mozilla Public License', (context / 'LICENSE').read_text())
            self.assertIn('/opt/hi-sam/LICENSE', (context / 'NOTICE').read_text())
            self.assertTrue((context / 'stroke_completion.py').is_file())

    def test_wrong_revision_dirty_source_and_existing_directory_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source, revision = self.upstream(directory)
            with patch.object(builder, 'REVISION', '0' * 40), self.assertRaises(ValueError):
                builder.prepare_context(source, directory / 'wrong')
            self.assertFalse((directory / 'wrong').exists())
            (source / 'source.py').write_text('modified source')
            with patch.object(builder, 'REVISION', revision), self.assertRaises(ValueError):
                builder.prepare_context(source, directory / 'dirty')
            self.assertFalse((directory / 'dirty').exists())
            subprocess.run(['git', '-C', str(source), 'restore', 'source.py'], check=True)
            destination = directory / 'existing'
            destination.mkdir()
            marker = destination / 'keep'
            marker.write_text('keep this file')
            with patch.object(builder, 'REVISION', revision), self.assertRaises(FileExistsError):
                builder.prepare_context(source, destination)
            self.assertEqual(marker.read_text(), 'keep this file')


if __name__ == '__main__':
    unittest.main()
