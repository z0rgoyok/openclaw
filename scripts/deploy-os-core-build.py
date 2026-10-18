#!/usr/bin/env python3
"""Build an immutable transport artifact from a Deploy OS authored specification."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import urllib.request
import uuid

REPOSITORY = 'z0rgoyok/openclaw'
SOURCE_INPUTS = {'Dockerfile', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
                 'ui/package.json', 'extensions/browser/package.json', 'extensions/qa-lab/package.json'}
BUILD_ARGS = {'OPENCLAW_EXTENSIONS', 'GIT_COMMIT', 'OPENCLAW_DOCKER_BUILD_VERSION',
              'OPENCLAW_IMAGE_APT_PACKAGES', 'OPENCLAW_DOCKER_BUILD_NODE_OPTIONS',
              'OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB', 'OPENCLAW_DOCKER_BUILD_SKIP_DTS'}
BUILDKIT_CONFIG = '[worker.oci]\nmax-parallelism = 1\n'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def file_hash(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def load_spec(encoded):
    require(isinstance(encoded, str) and len(encoded) <= 262144, 'Build specification exceeds budget')
    raw = base64.b64decode(encoded, validate=True)
    value = json.loads(raw)
    keys = {'schema', 'kind', 'source_repo', 'source_commit', 'merged_pr', 'source_tree',
            'source_archive_sha256', 'source_inputs', 'recipe', 'recipe_sha256',
            'compiler_profile', 'build_args'}
    require(isinstance(value, dict) and set(value) == keys and type(value['schema']) is int and value['schema'] == 1 and
            value['kind'] == 'deploy-os-core-build' and value['source_repo'] == REPOSITORY,
            'Unsupported build specification')
    for key, length in [('source_commit', 40), ('source_tree', 40),
                        ('source_archive_sha256', 64), ('recipe_sha256', 64)]:
        require(isinstance(value[key], str) and re.fullmatch('[a-f0-9]{' + str(length) + '}', value[key]),
                'Invalid immutable source identity')
    require(type(value['merged_pr']) is int and value['merged_pr'] > 0, 'Merged PR required')
    require(isinstance(value['recipe'], str) and 0 < len(value['recipe']) <= 131072 and
            digest(value['recipe'].encode()) == value['recipe_sha256'], 'Recipe hash mismatch')
    require(isinstance(value['source_inputs'], dict) and set(value['source_inputs']) == SOURCE_INPUTS and
            all(isinstance(item, str) and re.fullmatch('[a-f0-9]{64}', item)
                for item in value['source_inputs'].values()), 'Source input hash contract mismatch')
    profile = value['compiler_profile']
    require(isinstance(profile, dict) and set(profile) == {
        'memory', 'memory_swap', 'cpus', 'platform', 'package_manager', 'extensions',
        'max_parallelism', 'buildkit_config_sha256', 'vm_memory_minimum_bytes', 'cpuset_cpus',
        'compiler_concurrency', 'thread_env'} and
        all(type(profile.get(key)) is type(expected) and profile.get(key) == expected for key, expected in {
        'memory': '10g', 'memory_swap': '10g', 'cpus': '2', 'platform': 'linux/amd64',
        'cpuset_cpus': '0,1', 'max_parallelism': 1, 'compiler_concurrency': 1,
        'vm_memory_minimum_bytes': 12 * 1024**3,
        'buildkit_config_sha256': digest(BUILDKIT_CONFIG.encode()),
        'thread_env': {'ROLLDOWN_WORKER_THREADS': '2', 'ROLLDOWN_MAX_BLOCKING_THREADS': '2',
                       'RAYON_NUM_THREADS': '2'},
    }.items()), 'Unsupported bounded compiler profile')
    arguments = value['build_args']
    require(isinstance(arguments, dict) and set(arguments) == BUILD_ARGS and
            all(isinstance(item, str) and 0 < len(item) <= 1024 and '\n' not in item and '\r' not in item
                for item in arguments.values()), 'Unsupported build arguments')
    require(arguments['GIT_COMMIT'] == value['source_commit'] and
            arguments['OPENCLAW_EXTENSIONS'] == profile.get('extensions'), 'Build source/profile drift')
    return value


def verify_merged_pr(spec, token):
    require(token, 'GitHub read token required for merged source verification')
    request = urllib.request.Request(
        f"https://api.github.com/repos/{REPOSITORY}/pulls/{spec['merged_pr']}",
        headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                 'X-GitHub-Api-Version': '2022-11-28', 'Cache-Control': 'no-cache',
                 'User-Agent': 'Deploy-OS-core-build'})
    with urllib.request.urlopen(request, timeout=30) as response:
        value = json.load(response)
    require(value.get('merged_at') and value.get('state') == 'closed' and
            value.get('merge_commit_sha') == spec['source_commit'] and
            value.get('base', {}).get('repo', {}).get('full_name') == REPOSITORY, 'Exact merged source PR required')


def run(command, **kwargs):
    return subprocess.check_output(command, timeout=kwargs.pop('timeout', 120), **kwargs)


def image_metadata(image, commit):
    value = json.loads(run(['docker', 'image', 'inspect', image]))[0]
    require(value['Id'] == image and value['Architecture'] == 'amd64' and value['Os'] == 'linux' and
            not value['Config'].get('Volumes'), 'Image identity/platform drift')
    labels = value['Config'].get('Labels', {})
    require(labels.get('org.opencontainers.image.source') == 'https://github.com/' + REPOSITORY and
            labels.get('org.opencontainers.image.revision') == commit, 'Image origin drift')
    for item in value['Config'].get('Env', []):
        name, separator, content = item.partition('=')
        require(not (separator and content and re.search('TOKEN|SECRET|API_KEY|PASSWORD|AUTH', name, re.I)),
                'Image credential environment rejected')
    return {'id': value['Id'], 'rootfs': value['RootFS'], 'labels': labels, 'bytes': value['Size']}


def export(command, destination, timeout):
    with destination.open('xb') as output:
        subprocess.run(command, stdout=output, check=True, timeout=timeout)


def build(spec, source, output):
    source = source.resolve(strict=True)
    commit = spec['source_commit']
    require(run(['git', '-C', str(source), 'rev-parse', 'HEAD']).decode().strip() == commit and
            run(['git', '-C', str(source), 'rev-parse', 'HEAD^{tree}']).decode().strip() == spec['source_tree'],
            'Checked-out source identity mismatch')
    memory = json.loads(run(['docker', 'info', '--format', '{{json .MemTotal}}']))
    require(type(memory) is int and memory >= spec['compiler_profile']['vm_memory_minimum_bytes'],
            'Runner memory below compiler reserve')
    resources = {'vmMemoryBytes': memory, 'builderMemoryBytes': 10 * 1024**3,
                 'reserveBytes': 2 * 1024**3, 'maxParallelism': 1, 'cpus': 2, 'pidsLimit': 512}
    output.mkdir(parents=True, exist_ok=False)
    owner = 'deploy-os-core-' + uuid.uuid4().hex
    export_container = owner + '-export'
    fork_tag, runtime_tag = owner + ':fork', owner + ':runtime'
    builder_created = False
    export_created = False
    try:
        with tempfile.TemporaryDirectory(prefix='deploy-os-core-') as scratch:
            scratch = Path(scratch)
            archive = scratch / 'source.tar'
            export(['git', '-C', str(source), 'archive', '--format=tar', commit], archive, 120)
            require(file_hash(archive) == spec['source_archive_sha256'], 'Source archive hash mismatch')
            context = scratch / 'source'
            context.mkdir()
            with tarfile.open(archive) as tree:
                tree.extractall(context, filter='data')
            for relative, expected in spec['source_inputs'].items():
                path = context / relative
                require(path.is_file() and not path.is_symlink() and file_hash(path) == expected,
                        'Source input bytes mismatch')
            package = json.loads((context / 'package.json').read_bytes())
            require(package.get('packageManager') == spec['compiler_profile'].get('package_manager') and
                    package.get('version') == spec['build_args']['OPENCLAW_DOCKER_BUILD_VERSION'],
                    'Package toolchain/version mismatch')
            recipe = context / 'Dockerfile.core-release'
            with recipe.open('x') as stream:
                stream.write(spec['recipe'])
            config = scratch / 'buildkitd.toml'
            config.write_text(BUILDKIT_CONFIG)
            builder_created = True
            subprocess.run(['docker', 'buildx', 'create', '--name', owner, '--driver', 'docker-container',
                            '--driver-opt', 'memory=10g,memory-swap=10g,cpu-period=100000,cpu-quota=200000',
                            '--driver-opt', '"cpuset-cpus=0,1"', '--buildkitd-config', str(config)],
                           check=True, timeout=120)
            subprocess.run(['docker', 'buildx', 'inspect', '--builder', owner, '--bootstrap'],
                           check=True, timeout=180)
            builder_container = 'buildx_buildkit_' + owner + '0'
            builder_info = json.loads(run(['docker', 'inspect', builder_container]))[0]
            require(builder_info.get('Name') == '/' + builder_container and
                    re.fullmatch('[a-f0-9]{64}', builder_info.get('Id', '')),
                    'Owned builder container identity mismatch')
            builder_id = builder_info['Id']
            subprocess.run(['docker', 'update', '--pids-limit', '512', builder_id],
                           check=True, timeout=60)
            builder_info = json.loads(run(['docker', 'inspect', builder_id]))[0]
            require(builder_info.get('Id') == builder_id and builder_info.get('Name') == '/' + builder_container,
                    'Owned builder container changed')
            limits = builder_info['HostConfig']
            require(limits['Memory'] == 10 * 1024**3 and limits['MemorySwap'] == 10 * 1024**3 and
                    limits['CpuQuota'] == 200000 and limits['CpuPeriod'] == 100000 and
                    limits['CpusetCpus'] == '0,1' and limits['PidsLimit'] == 512,
                    'Builder resource limits mismatch')
            common = ['docker', 'buildx', 'build', '--builder', owner, '--platform', 'linux/amd64',
                      '--load', '-f', str(recipe)]
            for key, value in sorted(spec['build_args'].items()):
                common.extend(['--build-arg', key + '=' + value])
            common.extend(['--label', 'org.opencontainers.image.source=https://github.com/' + REPOSITORY,
                           '--label', 'org.opencontainers.image.revision=' + commit])
            for target, tag, timeout in [('managed-fork', fork_tag, 3600), ('managed-runtime', runtime_tag, 600)]:
                subprocess.run([*common, '--target', target, '-t', tag, str(context)], check=True, timeout=timeout)
            fork_id = json.loads(run(['docker', 'image', 'inspect', fork_tag]))[0]['Id']
            runtime_id = json.loads(run(['docker', 'image', 'inspect', runtime_tag]))[0]['Id']
            fork_image = image_metadata(fork_id, commit)
            image = image_metadata(runtime_id, commit)
            export_created = True
            subprocess.run(['docker', 'create', '--name', export_container, '--network', 'none',
                            '--label', 'deploy-os.core-release=' + owner, '--entrypoint', '/bin/true', fork_id],
                           check=True, timeout=60)
            export(['docker', 'cp', export_container + ':/app', '-'], output / 'app.tar', 180)
            export(['docker', 'save', runtime_tag], output / 'image.tar', 300)
            manifest = {'schema': 1, 'kind': 'deploy-os-core-build-result', 'spec_sha256': digest(canonical(spec)),
                        'source_commit': commit, 'source_tree': spec['source_tree'],
                        'source_archive_sha256': spec['source_archive_sha256'],
                        'source_inputs': spec['source_inputs'], 'recipe_sha256': spec['recipe_sha256'],
                        'compiler': spec['compiler_profile'], 'build_resources': resources,
                        'build_owner': {'name': owner, 'container_name': builder_container},
                        'fork_image': fork_image, 'image': image,
                        'app_archive_sha256': file_hash(output / 'app.tar'),
                        'image_archive_sha256': file_hash(output / 'image.tar')}
            (output / 'build-result.json').write_bytes(canonical(manifest))
    finally:
        cleanup = []
        if export_created:
            cleanup.append((['docker', 'rm', '-f', export_container], 60))
        if builder_created:
            cleanup.append((['docker', 'buildx', 'rm', '--force', owner], 120))
        failures = []
        for command, timeout in cleanup:
            try:
                subprocess.run(command, check=True, timeout=timeout)
            except (subprocess.SubprocessError, OSError) as error:
                failures.append(error)
        if failures:
            raise RuntimeError('Owned build resource cleanup failed') from failures[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'build'))
    parser.add_argument('--source', type=Path)
    parser.add_argument('--output', type=Path)
    arguments = parser.parse_args()
    spec = load_spec(os.environ.get('DEPLOY_OS_BUILD_SPEC', ''))
    if arguments.action == 'prepare':
        verify_merged_pr(spec, os.environ.get('GH_TOKEN', ''))
        with Path(os.environ['GITHUB_OUTPUT']).open('a') as stream:
            stream.write('source_commit=' + spec['source_commit'] + '\n')
            stream.write('artifact_name=core-build-' + spec['source_commit'] + '\n')
    else:
        require(arguments.source is not None and arguments.output is not None, 'Source/output required')
        build(spec, arguments.source, arguments.output)


if __name__ == '__main__':
    main()
