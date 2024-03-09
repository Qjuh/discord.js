/* eslint-disable no-case-declarations */
// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { JsonFile } from '@rushstack/node-core-library';
import colors from 'colors';
import * as ts from 'typescript';
import type { IExtractorInvokeOptions } from './Extractor.js';
import { ExtractorConfig } from './ExtractorConfig.js';

/**
 * Options for {@link CompilerState.create}
 *
 * @public
 */
export interface ICompilerStateCreateOptions {
	/**
	 * Additional .d.ts files to include in the analysis.
	 */
	additionalEntryPoints?: string[];

	/**
	 * {@inheritDoc IExtractorInvokeOptions.typescriptCompilerFolder}
	 */
	typescriptCompilerFolder?: string | undefined;
}

const internalTypesToResolve = ['Exclude', 'Extract', 'Uppercase', 'Lowercase', 'Capitalize', 'Uncapitalize'];

/**
 * This class represents the TypeScript compiler state.  This allows an optimization where multiple invocations
 * of API Extractor can reuse the same TypeScript compiler analysis.
 *
 * @public
 */
export class CompilerState {
	/**
	 * The TypeScript compiler's `Program` object, which represents a complete scope of analysis.
	 */
	public readonly program: unknown;

	private constructor(properties: CompilerState) {
		this.program = properties.program;
	}

	/**
	 * Create a compiler state for use with the specified `IExtractorInvokeOptions`.
	 */
	public static create(extractorConfig: ExtractorConfig, options?: ICompilerStateCreateOptions): CompilerState {
		let tsconfig: {} | undefined = extractorConfig.overrideTsconfig;
		let configBasePath: string = extractorConfig.projectFolder;
		if (!tsconfig) {
			// If it wasn't overridden, then load it from disk
			tsconfig = JsonFile.load(extractorConfig.tsconfigFilePath);
			configBasePath = path.resolve(path.dirname(extractorConfig.tsconfigFilePath));
		}

		const commandLine: ts.ParsedCommandLine = ts.parseJsonConfigFileContent(tsconfig, ts.sys, configBasePath);

		if (!commandLine.options.skipLibCheck && extractorConfig.skipLibCheck) {
			commandLine.options.skipLibCheck = true;
			console.log(
				colors.cyan(
					'API Extractor was invoked with skipLibCheck. This is not recommended and may cause ' +
						'incorrect type analysis.',
				),
			);
		}

		const inputFilePaths: string[] = commandLine.fileNames.concat(extractorConfig.mainEntryPointFilePath);
		if (options?.additionalEntryPoints) {
			inputFilePaths.push(...options.additionalEntryPoints);
		}

		// Append the entry points and remove any non-declaration files from the list
		const analysisFilePaths: string[] = CompilerState._generateFilePathsForAnalysis(inputFilePaths);

		const compilerHost: ts.CompilerHost = CompilerState._createCompilerHost(commandLine, options);

		let program: ts.Program = ts.createProgram(analysisFilePaths, commandLine.options, compilerHost);

		if (commandLine.errors.length > 0) {
			const errorText: string = ts.flattenDiagnosticMessageText(commandLine.errors[0]!.messageText, '\n');
			throw new Error(`Error parsing tsconfig.json content: ${errorText}`);
		}

		if (!extractorConfig.mainEntryPointFilePath.includes('dist-docs')) {
			const typeChecker = program.getTypeChecker();
			const transformerFactory: ts.TransformerFactory<ts.SourceFile> = (context: ts.TransformationContext) => {
				return (rootNode) => {
					function visit<T extends ts.Node>(node: T): T {
						if (ts.isTypeNode(node) && !ts.isTemplateLiteralTypeNode(node)) {
							const type = typeChecker.getTypeFromTypeNode(node);
							if (
								ts.isConditionalTypeNode(node) ||
								ts.isMappedTypeNode(node) ||
								(ts.isTypeReferenceNode(node) &&
									ts.isIdentifier(node.typeName) &&
									internalTypesToResolve.includes(node.typeName.getText())) // &&
								// !ts.isUnionTypeNode(node) &&
								// !(
								// 	ts.isTypeReferenceNode(node) &&
								// 	ts.isIdentifier(node.typeName) &&
								// 	rootNode.statements.some(
								// 		(statement) =>
								// 			ts.isImportDeclaration(statement) &&
								// 			ts.isStringLiteralLike(statement.moduleSpecifier) &&
								// 			// ts.resolveModuleName(
								// 			// 	statement.moduleSpecifier.text,
								// 			// 	rootNode.fileName,
								// 			// 	program.getCompilerOptions(),
								// 			// 	ts.sys,
								// 			// ).resolvedModule?.isExternalLibraryImport &&
								// 			statement
								// 				.getChildren()
								// 				.find(
								// 					(clause) =>
								// 						ts.isImportClause(clause) &&
								// 						clause.namedBindings &&
								// 						ts.isNamedImports(clause.namedBindings) &&
								// 						clause.namedBindings.elements.some(
								// 							(name) =>
								// 								ts.isIdentifier(node.typeName) && name.name.escapedText === node.typeName.escapedText,
								// 						),
								// 				),
								// 	)
								// )
							) {
								return typeChecker.typeToTypeNode(
									type,
									node.parent,
									ts.NodeBuilderFlags.InTypeAlias | ts.NodeBuilderFlags.NoTruncation,
								) as T & ts.TypeNode;
							}
						} else if (ts.isGetAccessor(node) || ts.isHeritageClause(node) || ts.isTemplateLiteralTypeNode(node)) {
							return node;
						}

						return ts.visitEachChild(node, visit, context);
					}

					return ts.visitNode(rootNode, visit, ts.isSourceFile);
				};
			};

			const files = program.getSourceFiles().filter((file) => analysisFilePaths.includes(file.fileName));
			const printer = ts.createPrinter();
			const tempDir = path.join(path.dirname(extractorConfig.mainEntryPointFilePath), '..', 'dist-docs');

			if (!existsSync(tempDir)) {
				mkdirSync(tempDir);
			}

			const newAnalysisFilePaths = ts
				.transform(files, [transformerFactory], commandLine.options)
				.transformed.map((transformedSourceFile, index) => {
					const fileName = path.join(
						tempDir,
						path.relative(
							path.dirname(extractorConfig.mainEntryPointFilePath),
							path.dirname(transformedSourceFile.fileName),
						),
						path.basename(transformedSourceFile.fileName),
					);
					writeFileSync(fileName, printer.printNode(ts.EmitHint.Unspecified, transformedSourceFile, files[index]!));
					return fileName;
				});

			program = ts.createProgram(newAnalysisFilePaths, commandLine.options, compilerHost);

			// @ts-expect-error assignment to readonly property
			extractorConfig.mainEntryPointFilePath = path.resolve(
				tempDir,
				path.relative(path.dirname(extractorConfig.mainEntryPointFilePath), path.dirname(newAnalysisFilePaths[0]!)),
				path.basename(extractorConfig.mainEntryPointFilePath),
			);
		}

		return new CompilerState({
			program,
		});
	}

	/**
	 * Given a list of absolute file paths, return a list containing only the declaration
	 * files.  Duplicates are also eliminated.
	 *
	 * @remarks
	 * The tsconfig.json settings specify the compiler's input (a set of *.ts source files,
	 * plus some *.d.ts declaration files used for legacy typings).  However API Extractor
	 * analyzes the compiler's output (a set of *.d.ts entry point files, plus any legacy
	 * typings).  This requires API Extractor to generate a special file list when it invokes
	 * the compiler.
	 *
	 * Duplicates are removed so that entry points can be appended without worrying whether they
	 * may already appear in the tsconfig.json file list.
	 */
	private static _generateFilePathsForAnalysis(inputFilePaths: string[]): string[] {
		const analysisFilePaths: string[] = [];

		const seenFiles: Set<string> = new Set<string>();

		for (const inputFilePath of inputFilePaths) {
			const inputFileToUpper: string = inputFilePath.toUpperCase();
			if (!seenFiles.has(inputFileToUpper)) {
				seenFiles.add(inputFileToUpper);

				if (!path.isAbsolute(inputFilePath)) {
					throw new Error('Input file is not an absolute path: ' + inputFilePath);
				}

				if (ExtractorConfig.hasDtsFileExtension(inputFilePath)) {
					analysisFilePaths.push(inputFilePath);
				}
			}
		}

		return analysisFilePaths;
	}

	private static _createCompilerHost(
		commandLine: ts.ParsedCommandLine,
		options: IExtractorInvokeOptions | undefined,
	): ts.CompilerHost {
		// Create a default CompilerHost that we will override
		const compilerHost: ts.CompilerHost = ts.createCompilerHost(commandLine.options);

		// Save a copy of the original members.  Note that "compilerHost" cannot be the copy, because
		// createCompilerHost() captures that instance in a closure that is used by the members.
		const defaultCompilerHost: ts.CompilerHost = { ...compilerHost };

		if (options?.typescriptCompilerFolder) {
			// Prevent a closure parameter
			const typescriptCompilerLibFolder: string = path.join(options.typescriptCompilerFolder, 'lib');
			compilerHost.getDefaultLibLocation = () => typescriptCompilerLibFolder;
		}

		// Used by compilerHost.fileExists()
		// .d.ts file path --> whether the file exists
		const dtsExistsCache: Map<string, boolean> = new Map<string, boolean>();

		// Used by compilerHost.fileExists()
		// Example: "c:/folder/file.part.ts"
		const fileExtensionRegExp = /^(?<pathWithoutExtension>.+)(?<fileExtension>\.\w+)$/i;

		compilerHost.fileExists = (fileName: string): boolean => {
			// In certain deprecated setups, the compiler may write its output files (.js and .d.ts)
			// in the same folder as the corresponding input file (.ts or .tsx).  When following imports,
			// API Extractor wants to analyze the .d.ts file; however recent versions of the compiler engine
			// will instead choose the .ts file.  To work around this, we hook fileExists() to hide the
			// existence of those files.

			// Is "fileName" a .d.ts file?  The double extension ".d.ts" needs to be matched specially.
			if (!ExtractorConfig.hasDtsFileExtension(fileName)) {
				// It's not a .d.ts file.  Is the file extension a potential source file?
				const match: RegExpExecArray | null = fileExtensionRegExp.exec(fileName);
				if (match?.groups?.pathWithoutExtension && match.groups?.fileExtension) {
					// Example: "c:/folder/file.part"
					const pathWithoutExtension: string = match.groups.pathWithoutExtension;
					// Example: ".ts"
					const fileExtension: string = match.groups.fileExtension;

					switch (fileExtension.toLocaleLowerCase()) {
						case '.ts':
						case '.tsx':
						case '.js':
						case '.jsx':
							// Yes, this is a possible source file.  Is there a corresponding .d.ts file in the same folder?
							const dtsFileName = `${pathWithoutExtension}.d.ts`;

							let dtsFileExists: boolean | undefined = dtsExistsCache.get(dtsFileName);
							if (dtsFileExists === undefined) {
								dtsFileExists = defaultCompilerHost.fileExists!(dtsFileName);
								dtsExistsCache.set(dtsFileName, dtsFileExists);
							}

							if (dtsFileExists) {
								// fileName is a potential source file and a corresponding .d.ts file exists.
								// Thus, API Extractor should ignore this file (so the .d.ts file will get analyzed instead).
								return false;
							}

							break;
					}
				}
			}

			// Fall through to the default implementation
			return defaultCompilerHost.fileExists!(fileName);
		};

		return compilerHost;
	}
}
