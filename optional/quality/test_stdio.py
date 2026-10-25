import io
import sys
import unittest
from unittest import mock
from quality_lib import utf8_stdio


class Stdio(unittest.TestCase):
    def test_utf8_output_preserves_crlf_and_blank_lines_without_changing_stdin(self):
        with io.TextIOWrapper(io.BytesIO('输入\r\n\r\n末行\r'.encode('utf-8')), encoding='ascii', newline=None) as stdin, \
                io.TextIOWrapper(io.BytesIO(), encoding='ascii', newline='\r\n') as stdout, \
                io.TextIOWrapper(io.BytesIO(), encoding='ascii', newline='\r\n') as stderr:
            with mock.patch.object(sys, 'stdin', stdin), mock.patch.object(sys, 'stdout', stdout), \
                    mock.patch.object(sys, 'stderr', stderr):
                utf8_stdio()
                self.assertEqual(stdin.read(), '输入\n\n末行\n')
                self.assertEqual(stdin.errors, 'strict')
                stdout.write('中文\r\n\r\n末行\n\udcff')
                stderr.write('错误\r\n\r\n末行\n\udcff')
                stdout.flush(); stderr.flush()
                self.assertEqual(stdout.buffer.getvalue(), '中文\r\n\r\n末行\n?'.encode('utf-8'))
                self.assertEqual(stderr.buffer.getvalue(), '错误\r\n\r\n末行\n\\udcff'.encode('utf-8'))
