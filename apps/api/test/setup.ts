/**
 * Loaded before any test file. NestJS decorators (@Module, @Injectable,
 * @Controller, ...) rely on reflect-metadata being registered globally;
 * main.ts imports it as its very first line for the same reason.
 */
import 'reflect-metadata';
