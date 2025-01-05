import * as vscode from 'vscode';
import {
    decode_remote_host,
    encode_remote_host,
    FolderItem,
    HostBase,
    HostInfo,
    RemotesDataProvider,
} from './remotesView';

let outputChannel: vscode.OutputChannel;


function registerExplorer(context: vscode.ExtensionContext): RemotesDataProvider {
    let treeDataProvider = new RemotesDataProvider(context);
    const view = vscode.window.createTreeView('remoteHosts', {
        treeDataProvider: treeDataProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(view);
    return treeDataProvider;
}

export async function activate(context: vscode.ExtensionContext) {
    let remotesProvider = registerExplorer(context);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration('remote.OSS.hosts')) {
            await remotesProvider.readTree();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('remote-oss.configureHosts', async () => {
        vscode.commands.executeCommand("workbench.action.openSettingsJson");
    }));

    outputChannel = vscode.window.createOutputChannel('Remote OSS');

    async function doResolve(
        label: HostInfo,
        progress: vscode.Progress<{ message?: string; increment?: number }>,
    ): Promise<vscode.ResolvedAuthority> {
        const authority = await remotesProvider.resolveAuthority(label, outputChannel);
        context.subscriptions.push(vscode.workspace.registerResourceLabelFormatter({
            scheme: "vscode-remote",
            authority: "remote-oss+*",
            formatting: {
                label: "${path}",
                separator: "/",
                tildify: true,
                normalizeDriveLetter: false,
                workspaceSuffix: label.host,
            }
        }));
        // Enable ports view
        vscode.commands.executeCommand("setContext", "forwardedPortsViewEnabled", true);
        return authority;
    }

    const authorityResolverDisposable = vscode.workspace.registerRemoteAuthorityResolver('remote-oss', {
        async getCanonicalURI(uri: vscode.Uri): Promise<vscode.Uri> {
            return vscode.Uri.file(uri.path);
        },
        resolve(authority: string): Thenable<vscode.ResolvedAuthority> {
            outputChannel.appendLine(`resolving authority: ${authority}`);
            const hostInfo = decode_remote_host(authority);
            if (hostInfo) {
                return vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `connecting to ${hostInfo.host} ([details](command:remote-oss.showLog))`,
                    cancellable: false
                }, (progress) => doResolve(hostInfo, progress));
            }
            throw vscode.RemoteAuthorityResolverError.NotAvailable('Invalid', true);
        },
        // tunnelFactory,
        // showCandidatePort
    });
    context.subscriptions.push(authorityResolverDisposable);


    context.subscriptions.push(vscode.commands.registerCommand('remote-oss.openEmptyWindowInCurrentWindow',
        async (host?: HostBase) => {
            var label: string | undefined = undefined;
            if (!host) {
                label = await remotesProvider.pickHostLabel();
            } else {
                label = encode_remote_host({ type: "configured", host: host.name });
            }
            if (label) {
                vscode.window.showInformationMessage('resolving remote');
                vscode.commands.executeCommand("vscode.newWindow", {
                    remoteAuthority: label,
                    reuseWindow: true
                });
            }
        }));

    context.subscriptions.push(vscode.commands.registerCommand('remote-oss.openFolderInCurrentWindow',
        async (folder?: FolderItem) => {
            if (folder) {
                const encoded = encode_remote_host({ type: "configured", host: folder.host });
                const uri = vscode.Uri.parse(`vscode-remote://${encoded}${folder.path}`);
                vscode.commands.executeCommand("vscode.openFolder", uri);
            }
        }));

    context.subscriptions.push(vscode.commands.registerCommand('remote-oss.showLog', () => {
        if (outputChannel) {
            outputChannel.show();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('remote-oss.connectToTemporaryHost', async () => {
        const host = await vscode.window.showInputBox({
            placeHolder: "Enter the host (e.g., example.com:22)",
            prompt: "Temporary Host Connection",
        });

        if (!host) {
            await vscode.window.showErrorMessage("Host should not be empty.");
            return;
        }

        const match = host.match(/^\[([^\]]+)\]:(\d+)$|^([^:]+):(\d+)$/);
        if (!match) {
            await vscode.window.showErrorMessage("Invalid host format. Should be 'hostname:port' or '[ipv6]:port'.");
            return;
        }

        const hostname = match[1] || match[3];
        const port = match[2] || match[4];

        const authority = encode_remote_host({ type: "transient", host: hostname, port: parseInt(port) });
        const uri = vscode.Uri.parse(`vscode-remote://${authority}/`);
        vscode.commands.executeCommand("vscode.openFolder", uri);
    }));
}

export function deactivate() { }
