import { flags } from '@oclif/command';
import type { INode, INodeCredentialsDetails } from 'n8n-workflow';
import { jsonParse } from 'n8n-workflow';
import fs from 'fs';
import glob from 'fast-glob';
import { Container } from 'typedi';
import type { EntityManager } from 'typeorm';
import { v4 as uuid } from 'uuid';
import * as Db from '@/Db';
import { SharedWorkflow } from '@db/entities/SharedWorkflow';
import { WorkflowEntity } from '@db/entities/WorkflowEntity';
import type { Role } from '@db/entities/Role';
import type { User } from '@db/entities/User';
import { disableAutoGeneratedIds } from '@db/utils/commandHelpers';
import type { ICredentialsDb, IWorkflowToImport } from '@/Interfaces';
import { replaceInvalidCredentials } from '@/WorkflowHelpers';
import { BaseCommand, UM_FIX_INSTRUCTION } from '../BaseCommand';
import { generateNanoId } from '@db/utils/generators';
import { RoleService } from '@/services/role.service';
import { TagService } from '@/services/tag.service';

function assertHasWorkflowsToImport(workflows: unknown): asserts workflows is IWorkflowToImport[] {
	if (!Array.isArray(workflows)) {
		throw new Error(
			'File does not seem to contain workflows. Make sure the workflows are contained in an array.',
		);
	}

	for (const workflow of workflows) {
		if (
			typeof workflow !== 'object' ||
			!Object.prototype.hasOwnProperty.call(workflow, 'nodes') ||
			!Object.prototype.hasOwnProperty.call(workflow, 'connections')
		) {
			throw new Error('File does not seem to contain valid workflows.');
		}
	}
}

export class ImportWorkflowsCommand extends BaseCommand {
	static description = 'Import workflows';

	static examples = [
		'$ n8n import:workflow --input=file.json',
		'$ n8n import:workflow --separate --input=backups/latest/',
		'$ n8n import:workflow --input=file.json --userId=1d64c3d2-85fe-4a83-a649-e446b07b3aae',
		'$ n8n import:workflow --separate --input=backups/latest/ --userId=1d64c3d2-85fe-4a83-a649-e446b07b3aae',
	];

	static flags = {
		help: flags.help({ char: 'h' }),
		input: flags.string({
			char: 'i',
			description: 'Input file name or directory if --separate is used',
		}),
		separate: flags.boolean({
			description: 'Imports *.json files from directory provided by --input',
		}),
		userId: flags.string({
			description: 'The ID of the user to assign the imported workflows to',
		}),
	};

	private ownerWorkflowRole: Role;

	private transactionManager: EntityManager;

	private tagService: TagService;

	async init() {
		disableAutoGeneratedIds(WorkflowEntity);
		await super.init();
		this.tagService = Container.get(TagService);
	}

	async run(): Promise<void> {
		// eslint-disable-next-line @typescript-eslint/no-shadow
		const { flags } = this.parse(ImportWorkflowsCommand);

		if (!flags.input) {
			this.logger.info('An input file or directory with --input must be provided');
			return;
		}

		if (flags.separate) {
			if (fs.existsSync(flags.input)) {
				if (!fs.lstatSync(flags.input).isDirectory()) {
					this.logger.info('The argument to --input must be a directory');
					return;
				}
			}
		}

		await this.initOwnerWorkflowRole();
		const user = flags.userId ? await this.getAssignee(flags.userId) : await this.getOwner();

		const credentials = await Db.collections.Credentials.find();
		const tags = await this.tagService.getAll();

		let totalImported = 0;

		if (flags.separate) {
			let { input: inputPath } = flags;

			if (process.platform === 'win32') {
				inputPath = inputPath.replace(/\\/g, '/');
			}

			const files = await glob('*.json', {
				cwd: inputPath,
				absolute: true,
			});

			totalImported = files.length;
			this.logger.info(`Importing ${totalImported} workflows...`);
			await Db.getConnection().transaction(async (transactionManager) => {
				this.transactionManager = transactionManager;

				for (const file of files) {
					const workflow = jsonParse<IWorkflowToImport>(
						fs.readFileSync(file, { encoding: 'utf8' }),
					);
					if (!workflow.id) {
						workflow.id = generateNanoId();
					}

					if (credentials.length > 0) {
						workflow.nodes.forEach((node: INode) => {
							this.transformCredentials(node, credentials);

							if (!node.id) {
								node.id = uuid();
							}
						});
					}

					if (Object.prototype.hasOwnProperty.call(workflow, 'tags')) {
						await this.tagService.setTagsForImport(transactionManager, workflow, tags);
					}

					if (workflow.active) {
						this.logger.info(
							`Deactivating workflow "${workflow.name}" during import, remember to activate it later.`,
						);
						workflow.active = false;
					}

					await this.storeWorkflow(workflow, user);
				}
			});

			this.reportSuccess(totalImported);
			process.exit();
		}

		const workflows = jsonParse<IWorkflowToImport[]>(
			fs.readFileSync(flags.input, { encoding: 'utf8' }),
		);

		assertHasWorkflowsToImport(workflows);

		totalImported = workflows.length;

		await Db.getConnection().transaction(async (transactionManager) => {
			this.transactionManager = transactionManager;

			for (const workflow of workflows) {
				let oldCredentialFormat = false;
				if (credentials.length > 0) {
					workflow.nodes.forEach((node: INode) => {
						this.transformCredentials(node, credentials);
						if (!node.id) {
							node.id = uuid();
						}
						if (!node.credentials?.id) {
							oldCredentialFormat = true;
						}
					});
				}
				if (oldCredentialFormat) {
					try {
						await replaceInvalidCredentials(workflow as unknown as WorkflowEntity);
					} catch (error) {
						this.logger.error('Failed to replace invalid credential', error as Error);
					}
				}
				if (Object.prototype.hasOwnProperty.call(workflow, 'tags')) {
					await this.tagService.setTagsForImport(transactionManager, workflow, tags);
				}
				if (workflow.active) {
					this.logger.info(
						`Deactivating workflow "${workflow.name}" during import, remember to activate it later.`,
					);
					workflow.active = false;
				}

				await this.storeWorkflow(workflow, user);
			}
		});

		this.reportSuccess(totalImported);
	}

	async catch(error: Error) {
		this.logger.error('An error occurred while importing workflows. See log messages for details.');
		this.logger.error(error.message);
	}

	private reportSuccess(total: number) {
		this.logger.info(`Successfully imported ${total} ${total === 1 ? 'workflow.' : 'workflows.'}`);
	}

	private async initOwnerWorkflowRole() {
		const ownerWorkflowRole = await Container.get(RoleService).findWorkflowOwnerRole();

		if (!ownerWorkflowRole) {
			throw new Error(`Failed to find owner workflow role. ${UM_FIX_INSTRUCTION}`);
		}

		this.ownerWorkflowRole = ownerWorkflowRole;
	}

	private async storeWorkflow(workflow: object, user: User) {
		const result = await this.transactionManager.upsert(WorkflowEntity, workflow, ['id']);
		await this.transactionManager.upsert(
			SharedWorkflow,
			{
				workflowId: result.identifiers[0].id as string,
				userId: user.id,
				roleId: this.ownerWorkflowRole.id,
			},
			['workflowId', 'userId'],
		);
	}

	private async getOwner() {
		const ownerGlobalRole = await Container.get(RoleService).findGlobalOwnerRole();

		const owner =
			ownerGlobalRole &&
			(await Db.collections.User.findOneBy({ globalRoleId: ownerGlobalRole?.id }));

		if (!owner) {
			throw new Error(`Failed to find owner. ${UM_FIX_INSTRUCTION}`);
		}

		return owner;
	}

	private async getAssignee(userId: string) {
		const user = await Db.collections.User.findOneBy({ id: userId });

		if (!user) {
			throw new Error(`Failed to find user with ID ${userId}`);
		}

		return user;
	}

	private transformCredentials(node: INode, credentialsEntities: ICredentialsDb[]) {
		if (node.credentials) {
			const allNodeCredentials = Object.entries(node.credentials);
			for (const [type, name] of allNodeCredentials) {
				if (typeof name === 'string') {
					const nodeCredentials: INodeCredentialsDetails = {
						id: null,
						name,
					};

					const matchingCredentials = credentialsEntities.filter(
						(credentials) => credentials.name === name && credentials.type === type,
					);

					if (matchingCredentials.length === 1) {
						nodeCredentials.id = matchingCredentials[0].id;
					}

					node.credentials[type] = nodeCredentials;
				}
			}
		}
	}
}
