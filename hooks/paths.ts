/**
 * Where the session runs: the host decides how paths are spelled and how the dashboard is reached.
 */
export type Host = 'windows' | 'wsl' | 'posix';

const IMAGE_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
};

/**
 * The MIME type of an image file the dashboard can show, or undefined for any other file.
 */
export function imageType(path: string): string | undefined {
    const extension = path.split('.').pop()?.toLowerCase() ?? '';

    return IMAGE_TYPES[extension];
}

/**
 * The last segment of a Windows or POSIX path.
 */
export function baseName(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * Spells a path the way the session's host reads it, so a model can pass Windows and WSL paths alike.
 */
export function toLocalPath(path: string, host: Host): string {
    if (host === 'wsl') {
        const [, drive, rest = ''] = path.match(/^([A-Za-z]):[\\/](.*)$/) ?? [];

        return drive ? `/mnt/${drive.toLowerCase()}/${rest.replaceAll('\\', '/')}` : path;
    }

    if (host === 'windows') {
        const [, drive, rest = ''] = path.match(/^\/(?:mnt\/)?([A-Za-z])\/(.*)$/) ?? [];

        return drive ? `${drive.toUpperCase()}:\\${rest.replaceAll('/', '\\')}` : path;
    }

    return path;
}

/**
 * Respells every Windows path in a text the way the session's host reads it, so the paths the board writes into
 * a message open from WSL too.
 */
export function localizePaths(text: string, host: Host): string {
    return text.replace(/[A-Za-z]:\\[^\s"]+/g, path => toLocalPath(path, host))
}

/**
 * Spells a path of the session's host the way a Windows process reads it; WSL files go through the distro's share.
 */
export function toWindowsPath(path: string, host: Host, distro?: string): string {
    if (host !== 'wsl') {
        return path;
    }

    const [, drive, rest = ''] = path.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/) ?? [];

    if (drive) {
        return `${drive.toUpperCase()}:\\${rest.replaceAll('/', '\\')}`;
    }

    return `\\\\wsl.localhost\\${distro ?? 'Ubuntu'}${path.replaceAll('/', '\\')}`;
}

/**
 * The folder name Claude Code keeps a project's transcripts under.
 */
export function projectSlug(cwd: string): string {
    return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * The default gateway in `ip route show default` output: the Windows side of WSL's virtual network.
 */
export function parseGateway(output: string): string | undefined {
    return output.match(/default via (\d+\.\d+\.\d+\.\d+)/)?.[1];
}
