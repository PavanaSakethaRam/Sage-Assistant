# OS-native onedir console core. Native Copilot/gh resources never enter Analysis.
from importlib.metadata import distribution
from PyInstaller.utils.hooks import collect_data_files, copy_metadata

runtime_packages = ['github-copilot-sdk', 'pydantic', 'pydantic-core', 'platformdirs',
                    'httpx', 'httpcore', 'anyio', 'certifi', 'h11', 'idna',
                    'python-dateutil', 'six', 'typing-extensions', 'typing-inspection',
                    'annotated-types', 'tzdata']
datas = collect_data_files('sage', includes=['migrations/*.sql'])
datas += collect_data_files('tzdata')
for package in runtime_packages:
    distribution(package)  # Missing locked runtime dependency is a build failure.
    datas += copy_metadata(package)
a = Analysis(['src/sage/__main__.py'], pathex=['src'], datas=datas,
             hiddenimports=['copilot.generated.rpc', 'tzdata'],
             excludes=['pytest', 'tests', 'tkinter', 'unittest', 'pydoc',
                       'pydantic.mypy', 'pydantic.v1.mypy', 'pydantic._hypothesis_plugin'], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='sage-core', debug=False,
          bootloader_ignore_signals=False, strip=False, upx=False, console=True,
          target_arch=None, codesign_identity=None, entitlements_file=None)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='core')
