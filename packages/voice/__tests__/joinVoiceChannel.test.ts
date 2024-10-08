// @ts-nocheck
import { describe, test, expect, vitest, beforeAll, beforeEach } from 'vitest';
import * as VoiceConnection from '../src/VoiceConnection';
import { joinVoiceChannel } from '../src/joinVoiceChannel';

const adapterCreator = () => ({ destroy: vitest.fn(), send: vitest.fn() }) as any;
const createVoiceConnection = vitest.spyOn(VoiceConnection, 'createVoiceConnection');

beforeAll(() => {
	createVoiceConnection.mockImplementation(() => null as any);
});

beforeEach(() => {
	createVoiceConnection.mockClear();
});

describe('joinVoiceChannel', () => {
	test('Uses default group', () => {
		joinVoiceChannel({
			channelId: '123',
			guildId: '456',
			adapterCreator,
		});
		expect(createVoiceConnection.mock.calls[0][0]).toMatchObject({
			channelId: '123',
			guildId: '456',
			group: 'default',
		});
	});

	test('Respects custom group', () => {
		joinVoiceChannel({
			channelId: '123',
			guildId: '456',
			group: 'abc',
			adapterCreator,
		});
		expect(createVoiceConnection.mock.calls[0][0]).toMatchObject({
			channelId: '123',
			guildId: '456',
			group: 'abc',
		});
	});
});
