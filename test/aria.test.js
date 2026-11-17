import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeLine, cleanTitle, formatTime, normTrack, parseLRC, pickImage, uniqueTracks, windowAround } from '../public/aria/lib.js';

test('싱크 가사를 시간순 줄로 바꾸고, 지금 부를 줄을 찾는다', () => {
  const lines = parseLRC('[00:12.50]둘째 줄\n[00:01.00]첫 줄\n[00:20.00][00:30.00]후렴\n가사 아닌 줄');
  assert.deepEqual(
    lines.map((line) => [line.time, line.text]),
    [
      [1000, '첫 줄'],
      [12500, '둘째 줄'],
      [20000, '후렴'],
      [30000, '후렴'],
    ],
  );
  assert.equal(activeLine(lines, 500), -1, '첫 줄 전');
  assert.equal(activeLine(lines, 12500), 1);
  assert.equal(activeLine(lines, 25000), 2);
  assert.equal(activeLine(lines, 99999), 3);
});

test('시간, 이미지 크기, 제목 정리', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(215_400), '3:35');
  const images = [
    { url: 'big', width: 640 },
    { url: 'mid', width: 300 },
    { url: 'small', width: 64 },
  ];
  assert.equal(pickImage(images, 120), 'mid');
  assert.equal(pickImage(images, 1000), 'big');
  assert.equal(pickImage([], 10), '');
  assert.equal(cleanTitle('Song (feat. Someone) - 2011 Remaster'), 'Song');
});

test('Spotify 곡을 화면용으로 바꾸고, 앨범 곡에는 앨범 아트를 붙인다', () => {
  const album = { id: 'al', name: '앨범', uri: 'spotify:album:al', images: [{ url: 'cover', width: 640 }] };
  const track = normTrack({ id: 't', uri: 'spotify:track:t', name: '곡', artists: [{ name: '가수', id: 'a' }], duration_ms: 1000, track_number: 3 }, album);
  assert.equal(track.cover, 'cover');
  assert.equal(track.album.uri, 'spotify:album:al');
  assert.equal(track.number, 3);
  assert.equal(uniqueTracks([track, { ...track }, null]).length, 1);
});

test('누른 곡을 기준으로 Spotify에 넘길 100곡을 자른다', () => {
  const tracks = Array.from({ length: 250 }, (_, index) => ({ uri: `u${index}` }));
  const middle = windowAround(tracks, 120);
  assert.equal(middle.uris.length, 100);
  assert.equal(middle.uris[middle.position], 'u120');
  const end = windowAround(tracks, 249);
  assert.equal(end.uris[end.position], 'u249');
  const short = windowAround(tracks.slice(0, 5), 2);
  assert.deepEqual([short.uris.length, short.position], [5, 2]);
});
