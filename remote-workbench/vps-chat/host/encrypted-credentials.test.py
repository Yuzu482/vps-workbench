"""Check the account viewer's encrypted profile gate without launching a browser."""
import importlib.util
import io
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("claude_account", Path(__file__).with_name("RemoteClaudeAccount.py"))
account = importlib.util.module_from_spec(spec)
spec.loader.exec_module(account)


class EncryptedProfileTests(unittest.TestCase):
    def test_profile_directory_requires_luks2_before_creation(self):
        with TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            profile_root = home / "snap" / "firefox" / "common"
            with patch.object(account.Path, "open", return_value=io.StringIO("CRYPT-LUKS1-" + "a" * 32 + "-fixture")):
                with self.assertRaises(RuntimeError):
                    account.encrypted_browser_root(home)
                self.assertFalse(profile_root.exists())
            with patch.object(account.Path, "open", return_value=io.StringIO("CRYPT-LUKS2-" + "a" * 32 + "-fixture")):
                self.assertEqual(account.encrypted_browser_root(home), profile_root)
                self.assertTrue(profile_root.is_dir())

    def test_profile_directory_rejects_redirected_storage(self):
        with TemporaryDirectory() as temporary, TemporaryDirectory() as outside:
            home = Path(temporary).resolve()
            (home / "snap").symlink_to(Path(outside).resolve(), target_is_directory=True)
            with patch.object(account.Path, "open", return_value=io.StringIO("CRYPT-LUKS2-" + "a" * 32 + "-fixture")):
                with self.assertRaises(RuntimeError):
                    account.encrypted_browser_root(home)
            self.assertFalse((Path(outside) / "firefox").exists())


if __name__ == "__main__":
    unittest.main()
